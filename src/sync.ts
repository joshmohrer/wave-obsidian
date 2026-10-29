import { WaveApiError, WaveClient } from "./api";
import { buildNote, hashText, localDate, normaliseForHash, noteBaseName, pickFolder, sanitizeName } from "./markdown";
import type { NoteRecord, SyncState, WaveSettings } from "./settings";
import type { BulkSession, SessionDetail, SessionListItem, Transcript, WaveFolder } from "./types";

/** What the engine needs from the vault. Implemented over Obsidian's Vault in main.ts and in-memory in tests. */
/** File times to stamp on a write, so the vault sorts notes by recording time. */
export interface WriteTimes {
	ctime?: number;
	mtime?: number;
}

export interface VaultIO {
	exists(path: string): Promise<boolean>;
	read(path: string): Promise<string>;
	create(path: string, content: string, times?: WriteTimes): Promise<void>;
	modify(path: string, content: string, times?: WriteTimes): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	trash(path: string): Promise<void>;
	ensureFolder(path: string): Promise<void>;
}

export type SyncPhase = "idle" | "folders" | "recent" | "backfill" | "refresh" | "waiting";

export interface SyncProgress {
	phase: SyncPhase;
	done: number;
	total: number | null;
	message?: string;
}

export interface SyncDeps {
	client: WaveClient;
	io: VaultIO;
	settings: () => WaveSettings;
	state: SyncState;
	save: () => Promise<void>;
	onProgress?: (progress: SyncProgress) => void;
	log?: (message: string) => void;
	sleep?: (ms: number) => Promise<void>;
	now?: () => number;
}

export type SyncReason = "startup" | "interval" | "manual" | "focus" | "connect" | "rebuild";

export interface SyncResult {
	created: number;
	updated: number;
	unchanged: number;
	keptEdits: number;
	removed: number;
	errors: number;
	aborted: boolean;
}

type Outcome = "created" | "updated" | "unchanged" | "kept-edit" | "skipped";

const PAGE = 100;
const BACKFILL_PAGE = 50;
const BULK_MAX = 50;
const DEEP_REFRESH_EVERY_MS = 60 * 60 * 1000;
const DEEP_REFRESH_COUNT = 10;
const RATE_FLOOR = 3;

function parentOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? "" : path.slice(0, idx);
}

function joinPath(...parts: string[]): string {
	return parts
		.filter((p) => p && p.length)
		.join("/")
		.replace(/\/+/g, "/")
		.replace(/^\/|\/$/g, "");
}

export function historyCutoff(history: WaveSettings["history"], now: number): string | null {
	if (history === "all") return null;
	const days = Number(history);
	if (!Number.isFinite(days) || days <= 0) return null;
	return new Date(now - days * 24 * 60 * 60 * 1000).toISOString();
}

/** The wave_id property of a note the plugin (on any device) wrote, or null. */
export function waveIdOf(content: string): string | null {
	if (!content.startsWith("---")) return null;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return null;
	const match = content.slice(0, end).match(/^wave_id:\s*"?([^"\n]+?)"?\s*$/m);
	return match ? match[1].trim() : null;
}

function sameMeta(record: NoteRecord, item: SessionListItem): boolean {
	return (
		record.title === item.title &&
		record.timestamp === item.timestamp &&
		record.durationSeconds === item.duration_seconds
	);
}

export class SyncEngine {
	private running = false;
	private abortRequested = false;
	private folderCache = new Map<string, WaveFolder>();
	private result: SyncResult = this.freshResult();

	constructor(private readonly deps: SyncDeps) {}

	get isRunning(): boolean {
		return this.running;
	}

	abort(): void {
		this.abortRequested = true;
	}

	private freshResult(): SyncResult {
		return { created: 0, updated: 0, unchanged: 0, keptEdits: 0, removed: 0, errors: 0, aborted: false };
	}

	private get settings(): WaveSettings {
		return this.deps.settings();
	}

	private get state(): SyncState {
		return this.deps.state;
	}

	private now(): number {
		return this.deps.now ? this.deps.now() : Date.now();
	}

	private sleep(ms: number): Promise<void> {
		return this.deps.sleep ? this.deps.sleep(ms) : new Promise((resolve) => window.setTimeout(resolve, ms));
	}

	private log(message: string): void {
		this.deps.log?.(message);
	}

	private progress(phase: SyncPhase, done = 0, total: number | null = null, message?: string): void {
		this.deps.onProgress?.({ phase, done, total, message });
	}

	/** Run one sync pass. Returns null when a pass is already running. */
	async run(reason: SyncReason): Promise<SyncResult | null> {
		if (this.running) return null;
		if (!this.settings.token) return null;
		this.running = true;
		this.abortRequested = false;
		this.result = this.freshResult();
		this.log(`sync start (${reason})`);
		try {
			await this.loadFolders();
			await this.deps.io.ensureFolder(this.settings.baseFolder || "Wave");
			await this.syncRecent();
			await this.backfill();
			await this.deepRefresh();
			this.state.lastError = null;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.state.lastError = error instanceof WaveApiError ? error.code : message;
			this.log(`sync failed: ${message}`);
			throw error;
		} finally {
			this.state.lastSyncAt = this.now();
			this.result.aborted = this.abortRequested;
			await this.deps.save();
			this.running = false;
			this.progress("idle");
			this.log(`sync done ${JSON.stringify(this.result)}`);
		}
		return this.result;
	}

	/**
	 * Forget sync position (not the notes) so the next pass re-walks all history, rewrites unedited
	 * notes and brings back notes that were removed from the vault.
	 */
	scheduleRebuild(): void {
		this.state.backfillDone = false;
		this.state.backfillCursor = null;
		this.state.rebuildPending = true;
		this.state.deleted = {};
	}

	// --- Vault hooks -------------------------------------------------------------------------------

	/** The user deleted a file or folder from the vault. Matching notes are never recreated. */
	noteDeleted(path: string, isFolder: boolean): boolean {
		let changed = false;
		for (const [id, record] of Object.entries(this.state.notes)) {
			if (record.path === path || (isFolder && record.path.startsWith(`${path}/`))) {
				delete this.state.notes[id];
				delete this.state.forgotten[id];
				this.state.deleted[id] = true;
				changed = true;
			}
		}
		return changed;
	}

	/** The user moved or renamed a file or folder. Keep following the note at its new path. */
	noteRenamed(oldPath: string, newPath: string, isFolder: boolean): boolean {
		let changed = false;
		for (const record of Object.values(this.state.notes)) {
			if (record.path === oldPath) {
				record.path = newPath;
				changed = true;
			} else if (isFolder && record.path.startsWith(`${oldPath}/`)) {
				record.path = `${newPath}${record.path.slice(oldPath.length)}`;
				changed = true;
			}
		}
		return changed;
	}

	/**
	 * A file appeared in the vault (Obsidian Sync, iCloud, a rename done in Finder…). If it carries a
	 * wave_id the plugin doesn't track, adopt it instead of creating a duplicate later.
	 */
	adoptIfWaveNote(path: string, content: string, opts: { managed: boolean } = { managed: false }): boolean {
		const id = waveIdOf(content);
		if (!id) return false;
		const existing = this.state.notes[id];
		if (existing && existing.path === path) return false;
		if (existing && existing.path !== path) return false; // a copy; leave both alone
		this.state.notes[id] = {
			path,
			// A file the user placed is never moved by the plugin; one found where the plugin would put it is.
			managedPath: opts.managed ? path : "",
			hash: hashText(normaliseForHash(content)),
			title: "",
			timestamp: null,
			durationSeconds: -1,
			syncedAt: 0,
		};
		// A note that went missing and came back: judge edits against what the plugin last wrote.
		const lastWritten = this.state.forgotten[id];
		if (lastWritten !== undefined) {
			this.state.notes[id].hash = lastWritten;
			delete this.state.forgotten[id];
		}
		delete this.state.deleted[id];
		return true;
	}

	/** Session id for a vault path, if the plugin wrote it. */
	sessionIdForPath(path: string): string | null {
		for (const [id, record] of Object.entries(this.state.notes)) {
			if (record.path === path) return id;
		}
		return null;
	}

	// --- Phases ------------------------------------------------------------------------------------

	private async loadFolders(): Promise<void> {
		this.folderCache = new Map();
		if (!this.settings.mirrorFolders) return;
		this.progress("folders");
		const folders = await this.withRetry(() => this.deps.client.listFolders());
		for (const folder of folders) this.folderCache.set(folder.id, folder);
	}

	/**
	 * Newest page of recordings: creates new notes, refreshes ones whose title, date or
	 * length changed, and notices recordings that disappeared from Wave.
	 */
	private async syncRecent(): Promise<void> {
		this.progress("recent");
		const first = await this.withRetry(() => this.deps.client.listSessions({ limit: PAGE }));
		const items = [...first.sessions];
		const seen = new Set(items.map((s) => s.id));

		// More than a page of brand-new recordings since last time: keep paging until we reach what we knew.
		let cursor = first.next_cursor;
		let hasMore = first.has_more;
		const newest = this.state.newestSeen;
		while (hasMore && cursor && newest && cursor > newest && !this.abortRequested) {
			const page = await this.withRetry(() => this.deps.client.listSessions({ limit: PAGE, cursor, since: newest }));
			for (const s of page.sessions) {
				if (!seen.has(s.id)) {
					seen.add(s.id);
					items.push(s);
				}
			}
			cursor = page.next_cursor;
			hasMore = page.has_more;
		}

		// Oldest first so an interrupted pass leaves newestSeen honest.
		items.sort((a, b) => (a.timestamp ?? "").localeCompare(b.timestamp ?? ""));
		const firstRun = !this.state.newestSeen;
		const cutoff = historyCutoff(this.settings.history, this.now());
		const pending: SessionListItem[] = [];
		for (const item of items) {
			if (this.state.deleted[item.id]) continue;
			const tracked = this.state.notes[item.id];
			if (firstRun && !tracked) {
				// The backfill phase will create these in newest-first order.
				continue;
			}
			if (!tracked && cutoff && item.timestamp && item.timestamp < cutoff) continue;
			if (tracked && sameMeta(tracked, item)) {
				if (await this.deps.io.exists(tracked.path)) continue;
				if (!this.forgetMissing(item.id, tracked)) continue;
			}
			pending.push(item);
		}
		let done = 0;
		for (let i = 0; i < pending.length; i += BULK_MAX) {
			if (this.abortRequested) return;
			const chunk = pending.slice(i, i + BULK_MAX);
			await this.processBatch(chunk);
			done += chunk.length;
			this.progress("recent", done, pending.length);
			for (const item of chunk) {
				if (item.timestamp && (!this.state.newestSeen || item.timestamp > this.state.newestSeen)) {
					this.state.newestSeen = item.timestamp;
				}
			}
		}
		if (items.length) {
			const max = items.reduce<string | null>((acc, s) => (s.timestamp && (!acc || s.timestamp > acc) ? s.timestamp : acc), null);
			if (max && (!this.state.newestSeen || max > this.state.newestSeen)) this.state.newestSeen = max;
		}

		// Tracked notes inside the window the first page covers but missing from it were removed in Wave.
		if (first.sessions.length) {
			const oldest = first.sessions.reduce<string | null>(
				(acc, s) => (s.timestamp && (!acc || s.timestamp < acc) ? s.timestamp : acc),
				null,
			);
			const windowComplete = !first.has_more;
			for (const [id, record] of Object.entries(this.state.notes)) {
				if (seen.has(id)) continue;
				if (!record.timestamp) continue;
				if (windowComplete || (oldest && record.timestamp > oldest)) {
					if (this.abortRequested) return;
					await this.confirmWaveDelete(id);
				}
			}
		}
		await this.deps.save();
	}

	/** Walk older history newest-first until the chosen range is covered. Resumes across passes. */
	private async backfill(): Promise<void> {
		if (this.state.backfillDone) return;
		const cutoff = historyCutoff(this.settings.history, this.now());
		const cheap = !this.state.rebuildPending;
		let total: number | null = null;
		try {
			const account = await this.withRetry(() => this.deps.client.account());
			total = account.session_count ?? null;
		} catch {
			total = null;
		}
		let walked = Object.keys(this.state.notes).length;
		this.progress("backfill", walked, total);

		for (let guard = 0; guard < 10_000; guard++) {
			if (this.abortRequested) return;
			const page = await this.withRetry(() =>
				this.deps.client.listSessions({ limit: BACKFILL_PAGE, cursor: this.state.backfillCursor }),
			);
			if (!this.state.newestSeen && page.sessions.length) {
				this.state.newestSeen = page.sessions.reduce<string | null>(
					(acc, s) => (s.timestamp && (!acc || s.timestamp > acc) ? s.timestamp : acc),
					null,
				);
			}
			if (!page.sessions.length) {
				this.finishBackfill();
				return;
			}
			const batch: SessionListItem[] = [];
			let reachedCutoff = false;
			for (const item of page.sessions) {
				if (cutoff && item.timestamp && item.timestamp < cutoff) {
					reachedCutoff = true;
					break;
				}
				if (this.state.deleted[item.id]) continue;
				const tracked = this.state.notes[item.id];
				if (tracked && cheap && sameMeta(tracked, item)) {
					if ((await this.deps.io.exists(tracked.path)) || !this.forgetMissing(item.id, tracked)) {
						this.result.unchanged += 1;
						walked += 1;
						continue;
					}
				}
				batch.push(item);
			}
			if (this.abortRequested) return;
			const outcomes = await this.processBatch(batch);
			walked += outcomes.filter((o) => o !== "skipped").length;
			this.progress("backfill", walked, total);
			if (this.abortRequested) return;
			if (reachedCutoff) {
				this.finishBackfill();
				return;
			}
			this.state.backfillCursor = page.next_cursor;
			await this.deps.save();
			if (!page.has_more || !page.next_cursor) {
				this.finishBackfill();
				return;
			}
		}
	}

	private finishBackfill(): void {
		this.state.backfillDone = true;
		this.state.backfillCursor = null;
		this.state.rebuildPending = false;
		// Everything was just read in full; the hourly re-check can wait.
		this.state.lastDeepRefreshAt = this.now();
	}

	/** Once an hour, re-read the newest few recordings in full to catch summary, tag and folder edits. */
	private async deepRefresh(): Promise<void> {
		if (!this.state.backfillDone) return;
		const last = this.state.lastDeepRefreshAt ?? 0;
		if (this.now() - last < DEEP_REFRESH_EVERY_MS) return;
		const recent = Object.entries(this.state.notes)
			.filter(([, r]) => r.timestamp)
			.sort((a, b) => (b[1].timestamp ?? "").localeCompare(a[1].timestamp ?? ""))
			.slice(0, DEEP_REFRESH_COUNT);
		if (this.abortRequested) return;
		this.progress("refresh", 0, recent.length);
		await this.processBatch(
			recent.map(([id, record]) => ({
				id,
				title: record.title,
				timestamp: record.timestamp,
				duration_seconds: record.durationSeconds,
				type: "",
				platform: null,
			})),
		);
		this.progress("refresh", recent.length, recent.length);
		this.state.lastDeepRefreshAt = this.now();
		await this.deps.save();
	}

	// --- One recording -----------------------------------------------------------------------------

	/**
	 * Read up to 50 recordings in one bulk request and write their notes. Falls back to one
	 * request per recording if the server doesn't support the bulk fields yet.
	 */
	private async processBatch(items: SessionListItem[]): Promise<Outcome[]> {
		if (!items.length) return [];
		if (this.abortRequested) return items.map((): Outcome => "skipped");
		const wantTranscript = this.settings.transcript !== "off";
		let rows: BulkSession[] | null = null;
		if (items.length > 1 || this.bulkSupported) {
			await this.throttle();
			try {
				const res = await this.withRetry(() =>
					this.deps.client.bulkSessions(items.map((i) => i.id), { transcript: wantTranscript }),
				);
				rows = res.sessions ?? [];
				this.bulkSupported = true;
			} catch (error) {
				if (error instanceof WaveApiError && (error.code === "unauthorized" || error.code === "forbidden" || error.code === "rate_limited")) throw error;
				this.log(`bulk read failed, falling back to single reads: ${error instanceof Error ? error.message : String(error)}`);
				rows = null;
			}
		}
		const outcomes: Outcome[] = [];
		if (rows && rows.length && "tags" in rows[0]) {
			const byId = new Map(rows.map((r) => [r.id, r]));
			for (const item of items) {
				if (this.abortRequested) {
					outcomes.push("skipped");
					continue;
				}
				const row = byId.get(item.id);
				if (!row) {
					outcomes.push("skipped");
					continue;
				}
				const transcript: Transcript | null =
					wantTranscript && (row.segments?.length || row.transcript)
						? { id: row.id, transcript: row.transcript ?? "", segments: row.segments }
						: null;
				outcomes.push(await this.processItem(item, { cheap: false, preloaded: { detail: row, transcript } }));
			}
			return outcomes;
		}
		for (const item of items) {
			if (this.abortRequested) {
				outcomes.push("skipped");
				continue;
			}
			outcomes.push(await this.processItem(item, { cheap: false }));
		}
		return outcomes;
	}

	private bulkSupported = false;

	private async processItem(
		item: SessionListItem,
		opts: { cheap: boolean; preloaded?: { detail: SessionDetail; transcript: Transcript | null } },
	): Promise<Outcome> {
		try {
			const outcome = await this.processSession(item, opts);
			switch (outcome) {
				case "created":
					this.result.created += 1;
					break;
				case "updated":
					this.result.updated += 1;
					break;
				case "unchanged":
					this.result.unchanged += 1;
					break;
				case "kept-edit":
					this.result.keptEdits += 1;
					break;
				default:
					break;
			}
			return outcome;
		} catch (error) {
			if (error instanceof WaveApiError && (error.code === "unauthorized" || error.code === "forbidden")) throw error;
			if (error instanceof WaveApiError && error.code === "rate_limited") throw error;
			this.result.errors += 1;
			this.log(`session ${item.id} failed: ${error instanceof Error ? error.message : String(error)}`);
			return "skipped";
		}
	}

	private async processSession(
		item: SessionListItem,
		opts: { cheap: boolean; preloaded?: { detail: SessionDetail; transcript: Transcript | null } },
	): Promise<Outcome> {
		const id = item.id;
		if (this.state.deleted[id]) return "skipped";
		let tracked: NoteRecord | undefined = this.state.notes[id];

		if (tracked && opts.cheap && sameMeta(tracked, item)) {
			if (await this.deps.io.exists(tracked.path)) return "unchanged";
			if (!this.forgetMissing(id, tracked)) return "unchanged";
			tracked = undefined;
		}

		let detail: SessionDetail;
		let transcript: Transcript | null = null;
		if (opts.preloaded) {
			detail = opts.preloaded.detail;
			transcript = opts.preloaded.transcript;
		} else {
			await this.throttle();
			try {
				detail = await this.withRetry(() => this.deps.client.getSession(id));
			} catch (error) {
				if (error instanceof WaveApiError && error.code === "not_found") return "skipped";
				throw error;
			}
			if (this.settings.transcript !== "off") {
				await this.throttle();
				try {
					transcript = await this.withRetry(() => this.deps.client.getTranscript(id));
				} catch (error) {
					if (!(error instanceof WaveApiError && error.code === "not_found")) throw error;
				}
			}
		}
		if (detail.processing_status && detail.processing_status !== "completed") return "skipped";
		tracked = this.state.notes[id]; // a vault event may have adopted or removed the note during the fetch
		if (detail.phone?.ongoing) return "skipped";

		const folder = this.settings.mirrorFolders ? pickFolder(detail.folder_ids, this.folderCache) : null;
		const content = buildNote({
			session: detail,
			transcript,
			folderName: folder?.name ?? null,
			settings: this.settings,
		});
		const hash = hashText(normaliseForHash(content));
		const target = this.targetPath(detail, folder);
		const syncedAt = this.now();
		const recordedAt = detail.timestamp ? Date.parse(detail.timestamp) : NaN;
		const times: WriteTimes = Number.isFinite(recordedAt) ? { ctime: recordedAt, mtime: recordedAt } : {};

		if (tracked && !(await this.deps.io.exists(tracked.path))) {
			if (this.state.deleted[id]) return "skipped"; // removed in Obsidian while this pass was reading
			tracked = this.forgetMissing(id, tracked) ? undefined : this.state.notes[id];
		}

		if (!tracked && (await this.deps.io.exists(target))) {
			// Another device's plugin may already have written this note here, or the missing note is back.
			const existing = await this.deps.io.read(target);
			if (waveIdOf(existing) === id && this.adoptIfWaveNote(target, existing, { managed: true })) tracked = this.state.notes[id];
		}

		if (this.state.deleted[id]) return "skipped";

		if (tracked) {
			const current = await this.deps.io.read(tracked.path);
			const currentHash = hashText(normaliseForHash(current));
			// Not an edit if the file already holds exactly what Wave would write now (another device wrote it).
			const userEdited = currentHash !== tracked.hash && currentHash !== hash;

			if (tracked.path === tracked.managedPath && target !== tracked.path) {
				const dest = await this.uniquePath(target, id, detail.timestamp);
				await this.deps.io.ensureFolder(parentOf(dest));
				await this.deps.io.rename(tracked.path, dest);
				tracked.path = dest;
				tracked.managedPath = dest;
			}

			tracked.title = detail.title;
			tracked.timestamp = detail.timestamp;
			tracked.durationSeconds = detail.duration_seconds;

			if (userEdited) {
				await this.deps.save();
				return "kept-edit";
			}
			if (hash === tracked.hash) {
				if (!tracked.stamped && times.mtime) {
					// Written by an older version: give the file the recording's time once.
					await this.deps.io.modify(tracked.path, content, times);
					tracked.stamped = true;
				}
				await this.deps.save();
				return "unchanged";
			}
			await this.deps.io.modify(tracked.path, content, times);
			tracked.hash = hash;
			tracked.syncedAt = syncedAt;
			tracked.stamped = true;
			await this.deps.save();
			return "updated";
		}

		const dest = await this.uniquePath(target, id, detail.timestamp);
		await this.deps.io.ensureFolder(parentOf(dest));
		if (this.state.deleted[id]) return "skipped";
		if (this.state.notes[id]) return "skipped"; // adopted by a vault event meanwhile; the next pass refreshes it
		await this.deps.io.create(dest, content, times);
		delete this.state.forgotten[id];
		this.state.notes[id] = {
			path: dest,
			managedPath: dest,
			hash,
			title: detail.title,
			timestamp: detail.timestamp,
			durationSeconds: detail.duration_seconds,
			syncedAt,
			stamped: true,
		};
		await this.deps.save();
		return "created";
	}

	private targetPath(session: SessionDetail, folder: WaveFolder | null): string {
		const base = this.settings.baseFolder?.trim() || "Wave";
		const sub = folder ? sanitizeName(folder.name, "Folder") : "";
		return joinPath(base, sub, `${noteBaseName(session, this.settings.fileNameStyle)}.md`);
	}

	/**
	 * A path nobody else owns. Two recordings with the same title get the date added
	 * ("Weekly Standup (2026-10-13).md"); a third on the same day gets a counter.
	 */
	private async uniquePath(target: string, id: string, timestamp: string | null = null): Promise<string> {
		const free = async (path: string) => !(await this.deps.io.exists(path)) || this.sessionIdForPath(path) === id;
		if (await free(target)) return target;
		const stem = target.replace(/\.md$/, "");
		const date = localDate(timestamp);
		if (date && !stem.includes(date)) {
			const dated = `${stem} (${date}).md`;
			if (await free(dated)) return dated;
			for (let n = 2; n <= 50; n++) {
				const candidate = `${stem} (${date} ${n}).md`;
				if (await free(candidate)) return candidate;
			}
		}
		for (let n = 2; n <= 50; n++) {
			const candidate = `${stem} (${n}).md`;
			if (await free(candidate)) return candidate;
		}
		const short = id.replace(/[^A-Za-z0-9]/g, "").slice(-6) || "wave";
		return `${stem} (${short}).md`;
	}

	/**
	 * A tracked note is not where the plugin left it and no delete event was seen (another device's
	 * sync hasn't delivered it yet, a move done outside Obsidian, a restored vault…). Forget the record
	 * so the note is written again; only a delete inside Obsidian makes a note stay gone.
	 */
	private forgetMissing(id: string, record: NoteRecord): boolean {
		// A vault event may have adopted the note elsewhere while the file check was running.
		if (this.state.notes[id] !== record) return false;
		this.log(`note for ${id} is missing from the vault; it will be written again`);
		this.state.forgotten[id] = record.hash;
		delete this.state.notes[id];
		return true;
	}

	/** A tracked recording is gone from the list. Confirm with Wave before acting on it. */
	private async confirmWaveDelete(id: string): Promise<void> {
		await this.throttle();
		try {
			await this.withRetry(() => this.deps.client.getSession(id));
			return; // still there (its date moved); leave it alone
		} catch (error) {
			if (!(error instanceof WaveApiError && error.code === "not_found")) return;
		}
		const record = this.state.notes[id];
		if (!record) return;
		if (this.settings.onWaveDelete === "trash" && (await this.deps.io.exists(record.path))) {
			const current = await this.deps.io.read(record.path);
			if (hashText(normaliseForHash(current)) === record.hash) {
				await this.deps.io.trash(record.path);
				this.result.removed += 1;
			}
		}
		delete this.state.notes[id];
		delete this.state.forgotten[id];
		this.log(`session ${id} removed in Wave`);
	}

	// --- Rate limiting -----------------------------------------------------------------------------

	private async throttle(): Promise<void> {
		const client = this.deps.client;
		if (client.rateRemaining !== null && client.rateRemaining <= RATE_FLOOR && client.rateResetAt) {
			const wait = Math.min(Math.max(client.rateResetAt - this.now() + 500, 1_000), 65_000);
			this.progress("waiting", 0, null, `Waiting ${Math.ceil(wait / 1000)}s for Wave's rate limit`);
			await this.sleep(wait);
			client.rateRemaining = null;
		}
	}

	private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
		for (let attempt = 0; ; attempt++) {
			try {
				return await fn();
			} catch (error) {
				if (error instanceof WaveApiError && error.code === "rate_limited" && attempt < 3 && !this.abortRequested) {
					const wait = error.retryAfterMs ?? 15_000;
					this.progress("waiting", 0, null, `Waiting ${Math.ceil(wait / 1000)}s for Wave's rate limit`);
					await this.sleep(wait);
					continue;
				}
				if (error instanceof WaveApiError && (error.code === "server_error" || error.code === "network") && attempt < 2 && !this.abortRequested) {
					await this.sleep(2_000 * (attempt + 1));
					continue;
				}
				throw error;
			}
		}
	}
}
