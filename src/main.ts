import {
	addIcon,
	apiVersion,
	App,
	normalizePath,
	Notice,
	Platform,
	Plugin,
	PluginSettingTab,
	requestUrl,
	Setting,
	type SettingDefinition,
	type SettingDefinitionGroup,
	type SettingDefinitionItem,
	TAbstractFile,
	TFile,
	TFolder,
} from "obsidian";
import { WaveApiError, WaveClient, type HttpTransport } from "./api";
import {
	AUTHORIZE_URL,
	DEFAULT_SETTINGS,
	DEFAULT_STATE,
	HELP_URL,
	PROTOCOL_ACTION,
	TOKENS_SETTINGS_URL,
	WAVE_APP_URL,
	type SyncState,
	type WaveSettings,
} from "./settings";
import { SyncEngine, type SyncProgress, type SyncReason, type VaultIO } from "./sync";

const ICON_ID = "wave-ai";
const ICON_SVG =
	'<svg viewBox="0 0 19 26" fill="currentColor" xmlns="http://www.w3.org/2000/svg"><path d="M11.5175 23.2939C12.092 23.2939 12.5585 23.761 12.5585 24.3359C12.5585 24.9109 12.092 25.3779 11.5175 25.3779H7.10245C6.52808 25.3777 6.06241 24.9108 6.06241 24.3359C6.06243 23.7611 6.52809 23.2941 7.10245 23.2939H11.5175ZM16.3661 15.041C16.5306 14.4911 17.1114 14.1792 17.663 14.3438C18.2125 14.5083 18.5268 15.0895 18.3603 15.6416C17.1694 19.6099 13.4476 22.3809 9.30948 22.3809C5.17139 22.3808 1.44951 19.6099 0.258701 15.6416C0.0942688 15.0917 0.40652 14.5105 0.955966 14.3438C1.50545 14.1792 2.08623 14.4912 2.25284 15.041C3.18124 18.1346 6.083 20.2968 9.30948 20.2969C12.536 20.2969 15.4377 18.1367 16.3661 15.041ZM9.30851 0C12.8036 0 15.6347 2.8354 15.6347 6.33105V13.041C15.6347 16.5387 12.8015 19.3721 9.30851 19.3721C5.81361 19.3719 2.98235 16.5366 2.98233 13.041V6.33105C2.98233 2.83342 5.81568 0.000167258 9.30851 0ZM9.56046 6.27246C9.51871 5.98311 9.10126 5.98313 9.05948 6.27246L8.9462 7.03516C8.77336 8.21835 7.84531 9.14741 6.663 9.32031L5.90128 9.43262C5.61193 9.47428 5.61193 9.89291 5.90128 9.93457L6.663 10.0479C7.84536 10.2208 8.77343 11.1497 8.9462 12.333L9.05948 13.0947C9.10111 13.3843 9.51883 13.3843 9.56046 13.0947L9.67276 12.333C9.84554 11.1497 10.7746 10.2208 11.9569 10.0479L12.7187 9.93457C13.0078 9.89276 13.0078 9.47436 12.7187 9.43262L11.9569 9.32031C10.7746 9.14741 9.84556 8.2184 9.67276 7.03516L9.56046 6.27246ZM12.6327 4.13281C12.6116 3.99162 12.4087 3.99158 12.3876 4.13281L12.3339 4.50586C12.2485 5.085 11.7943 5.53763 11.2177 5.62305L10.8446 5.67676C10.7036 5.6979 10.7036 5.90174 10.8446 5.92285L11.2177 5.97656C11.7964 6.06197 12.2485 6.5167 12.3339 7.09375L12.3876 7.46582C12.4084 7.60748 12.6119 7.60748 12.6327 7.46582L12.6874 7.09375C12.7727 6.51473 13.2262 6.06211 13.8026 5.97656L14.1757 5.92285C14.3172 5.90202 14.3172 5.69762 14.1757 5.67676L13.8026 5.62305C13.2241 5.53751 12.7727 5.0828 12.6874 4.50586L12.6327 4.13281Z"/></svg>';

interface PersistedData {
	settings: Partial<WaveSettings>;
	state: Partial<SyncState>;
}

const FOCUS_SYNC_MIN_GAP_MS = 60 * 1000;

/** Obsidian's requestUrl: no CORS, works on desktop and mobile. */
const obsidianTransport: HttpTransport = async (req) => {
	const res = await requestUrl({
		url: req.url,
		method: req.method,
		headers: req.headers,
		body: req.body,
		throw: false,
	});
	return { status: res.status, headers: res.headers ?? {}, text: res.text ?? "" };
};

function randomState(): string {
	const bytes = new Uint8Array(16);
	crypto.getRandomValues(bytes);
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function relativeTime(ms: number, now: number): string {
	const diff = Math.max(0, now - ms);
	const minutes = Math.round(diff / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	return new Date(ms).toLocaleDateString();
}

/** Obsidian's Vault behind the engine's small interface. */
class ObsidianVaultIO implements VaultIO {
	constructor(private readonly app: App) {}

	private file(path: string): TFile | null {
		const abstract = this.app.vault.getAbstractFileByPath(normalizePath(path));
		return abstract instanceof TFile ? abstract : null;
	}

	async exists(path: string): Promise<boolean> {
		return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
	}

	async read(path: string): Promise<string> {
		const file = this.file(path);
		if (!file) throw new Error(`Not a file: ${path}`);
		return this.app.vault.read(file);
	}

	async create(path: string, content: string): Promise<void> {
		await this.app.vault.create(normalizePath(path), content);
	}

	async modify(path: string, content: string): Promise<void> {
		const file = this.file(path);
		if (!file) throw new Error(`Not a file: ${path}`);
		await this.app.vault.modify(file, content);
	}

	async rename(from: string, to: string): Promise<void> {
		const file = this.file(from);
		if (!file) throw new Error(`Not a file: ${from}`);
		await this.app.fileManager.renameFile(file, normalizePath(to));
	}

	async trash(path: string): Promise<void> {
		const file = this.file(path);
		if (!file) return;
		await this.app.fileManager.trashFile(file);
	}

	async ensureFolder(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (!normalized || normalized === "/") return;
		const parts = normalized.split("/");
		let current = "";
		for (const part of parts) {
			current = current ? `${current}/${part}` : part;
			const existing = this.app.vault.getAbstractFileByPath(current);
			if (existing instanceof TFolder) continue;
			if (existing) throw new Error(`A file is in the way of folder ${current}`);
			try {
				await this.app.vault.createFolder(current);
			} catch (error) {
				// Another writer may have created it between the check and the call.
				if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error;
			}
		}
	}
}

export default class WaveAIPlugin extends Plugin {
	settings: WaveSettings = { ...DEFAULT_SETTINGS };
	state: SyncState = { ...DEFAULT_STATE, notes: {}, deleted: {} };
	client!: WaveClient;
	engine!: SyncEngine;
	private statusBar: HTMLElement | null = null;
	private progress: SyncProgress = { phase: "idle", done: 0, total: null };
	/** Recent engine log lines, for the diagnostics copy. */
	private logLines: string[] = [];
	private settingTab: WaveSettingTab | null = null;
	private intervalId: number | null = null;
	private lastSyncStartedAt = 0;
	private authNoticeShown = false;
	private watchingVault = false;

	async onload(): Promise<void> {
		await this.loadPersisted();

		addIcon(ICON_ID, ICON_SVG);
		this.client = new WaveClient(() => this.settings.token, obsidianTransport, this.settings.apiBaseUrl);
		this.engine = new SyncEngine({
			client: this.client,
			io: new ObsidianVaultIO(this.app),
			settings: () => this.settings,
			state: this.state,
			save: () => this.savePersisted(),
			onProgress: (progress) => {
				this.progress = progress;
				this.renderStatus();
				this.settingTab?.renderStatus();
			},
			log: (message) => this.logLine(message),
		});

		this.addRibbonIcon(ICON_ID, "Sync Wave recordings", () => {
			void this.sync("manual");
		});

		this.statusBar = this.addStatusBarItem();
		this.statusBar.addClass("wave-ai-status");
		this.renderStatus();

		this.addCommand({
			id: "sync-now",
			name: "Sync now",
			callback: () => void this.sync("manual"),
		});
		this.addCommand({
			id: "open-in-wave",
			name: "Open current note in Wave",
			checkCallback: (checking) => {
				const file = this.app.workspace.getActiveFile();
				const id = file ? this.engine.sessionIdForPath(file.path) : null;
				if (!id) return false;
				if (!checking) window.open(`${WAVE_APP_URL}/sessions/${encodeURIComponent(id)}`);
				return true;
			},
		});
		this.addCommand({
			id: "rebuild-notes",
			name: "Rebuild notes from Wave",
			callback: () => {
				this.engine.scheduleRebuild();
				new Notice("Wave will re-read every recording and bring back notes you removed. Notes you edited are left alone.");
				void this.sync("rebuild");
			},
		});
		this.addCommand({
			id: "copy-diagnostics",
			name: "Copy diagnostics for Wave support",
			callback: () => void this.copyDiagnostics(),
		});

		this.settingTab = new WaveSettingTab(this.app, this);
		this.addSettingTab(this.settingTab);

		this.registerObsidianProtocolHandler(PROTOCOL_ACTION, (params) => {
			void this.finishConnect(params.token ?? "", params.state ?? "");
		});

		this.app.workspace.onLayoutReady(() => {
			this.watchVault();
			this.scheduleInterval();
			if (this.settings.token && this.settings.syncOnStartup) void this.sync("startup");
		});

		this.registerDomEvent(window, "focus", () => {
			if (!this.settings.token) return;
			if (Date.now() - this.lastSyncStartedAt < FOCUS_SYNC_MIN_GAP_MS) return;
			void this.sync("focus");
		});
	}

	onunload(): void {
		this.engine?.abort();
	}

	// --- Persistence -------------------------------------------------------------------------------

	private async loadPersisted(): Promise<void> {
		const raw = ((await this.loadData()) ?? {}) as Partial<PersistedData>;
		this.settings = { ...DEFAULT_SETTINGS, ...(raw.settings ?? {}) };
		this.state = { ...DEFAULT_STATE, notes: {}, deleted: {}, ...(raw.state ?? {}) };
		if (!this.state.notes) this.state.notes = {};
		if (!this.state.deleted) this.state.deleted = {};
	}

	async savePersisted(): Promise<void> {
		const data: PersistedData = { settings: this.settings, state: this.state };
		await this.saveData(data);
	}

	// --- Sync --------------------------------------------------------------------------------------

	scheduleInterval(): void {
		if (this.intervalId !== null) {
			window.clearInterval(this.intervalId);
			this.intervalId = null;
		}
		const minutes = Math.max(1, Math.round(this.settings.syncIntervalMinutes || 5));
		this.intervalId = window.setInterval(() => {
			if (this.settings.token) void this.sync("interval");
		}, minutes * 60 * 1000);
		this.registerInterval(this.intervalId);
	}

	async sync(reason: SyncReason): Promise<void> {
		if (!this.settings.token) {
			if (reason === "manual") new Notice("Connect Wave in Settings → Wave AI first.");
			return;
		}
		if (this.engine.isRunning) {
			if (reason === "manual") new Notice("Wave is already syncing.");
			return;
		}
		this.lastSyncStartedAt = Date.now();
		try {
			const result = await this.engine.run(reason);
			this.authNoticeShown = false;
			if (reason === "manual" && result) {
				const parts: string[] = [];
				if (result.created) parts.push(`${result.created} new`);
				if (result.updated) parts.push(`${result.updated} updated`);
				if (result.keptEdits) parts.push(`${result.keptEdits} kept your edits`);
				if (result.errors) parts.push(`${result.errors} failed`);
				new Notice(parts.length ? `Wave: ${parts.join(", ")}.` : "Wave: everything is up to date.");
			}
		} catch (error) {
			if (error instanceof WaveApiError && (error.code === "unauthorized" || error.code === "forbidden")) {
				if (!this.authNoticeShown || reason === "manual") {
					new Notice("Wave can't reach your account any more. Connect again in Settings → Wave AI.", 8000);
					this.authNoticeShown = true;
				}
			} else if (reason === "manual") {
				new Notice(`Wave sync failed: ${error instanceof Error ? error.message : String(error)}`, 8000);
			}
		} finally {
			this.renderStatus();
			this.settingTab?.renderStatus();
		}
	}

	renderStatus(): void {
		if (!this.statusBar) return;
		this.statusBar.setText(this.statusText());
	}

	private logLine(message: string): void {
		console.debug(`[Wave AI] ${message}`);
		this.logLines.push(`${new Date().toISOString()} ${message}`);
		if (this.logLines.length > 200) this.logLines.splice(0, this.logLines.length - 200);
	}

	/** Everything support needs to see what the plugin did, with nothing secret in it. */
	diagnosticsText(): string {
		const s = this.settings;
		const st = this.state;
		const notes = Object.values(st.notes);
		const newest = notes.reduce<string | null>((acc, n) => (n.timestamp && (!acc || n.timestamp > acc) ? n.timestamp : acc), null);
		const iso = (ms: number | null) => (ms ? new Date(ms).toISOString() : "never");
		const lines = [
			`Wave AI for Obsidian ${this.manifest.version} · Obsidian ${apiVersion} · ${Platform.isMobile ? "mobile" : "desktop"} · ${new Date().toISOString()}`,
			`account: ${s.accountEmail || "(not connected)"} · token: ${s.token ? "present" : "none"}`,
			`settings: folder=${s.baseFolder} mirrorFolders=${s.mirrorFolders} names=${s.fileNameStyle} transcript=${s.transcript} history=${s.history} every=${s.syncIntervalMinutes}m onStartup=${s.syncOnStartup} onWaveDelete=${s.onWaveDelete}`,
			`state: tracked=${notes.length} removed=${Object.keys(st.deleted).length} newestNote=${newest ?? "none"} newestSeen=${st.newestSeen ?? "none"} backfillDone=${st.backfillDone} cursor=${st.backfillCursor ?? "none"} rebuildPending=${st.rebuildPending}`,
			`last sync: ${iso(st.lastSyncAt)} · last error: ${st.lastError ?? "none"} · deep refresh: ${iso(st.lastDeepRefreshAt)} · phase now: ${this.progress.phase}`,
			"",
			"recent log:",
			...this.logLines.slice(-80),
		];
		return lines.join("\n");
	}

	async copyDiagnostics(): Promise<void> {
		const text = this.diagnosticsText();
		try {
			await navigator.clipboard.writeText(text);
			new Notice("Wave diagnostics copied. Paste them into your message to Wave support.", 6000);
		} catch {
			console.info(text);
			new Notice("Couldn't reach the clipboard. The diagnostics are in the developer console instead.", 8000);
		}
	}

	statusText(): string {
		if (!this.settings.token) return "Wave: not connected";
		const p = this.progress;
		if (p.phase === "waiting") return `Wave: ${p.message ?? "waiting"}`;
		if (p.phase === "backfill") {
			return p.total ? `Wave: syncing ${Math.min(p.done, p.total)}/${p.total}` : `Wave: syncing ${p.done}`;
		}
		if (p.phase !== "idle") return "Wave: syncing…";
		if (this.state.lastError === "unauthorized" || this.state.lastError === "forbidden") return "Wave: reconnect needed";
		if (this.state.lastError) return "Wave: sync failed, will retry";
		if (this.state.lastSyncAt) return `Wave: synced ${relativeTime(this.state.lastSyncAt, Date.now())}`;
		return "Wave: connected";
	}

	// --- Vault watching ----------------------------------------------------------------------------

	private watchVault(): void {
		if (this.watchingVault) return;
		this.watchingVault = true;
		this.registerEvent(
			this.app.vault.on("delete", (file: TAbstractFile) => {
				if (this.engine.noteDeleted(file.path, file instanceof TFolder)) void this.savePersisted();
			}),
		);
		this.registerEvent(
			this.app.vault.on("create", (file: TAbstractFile) => {
				if (!(file instanceof TFile) || file.extension !== "md") return;
				if (this.engine.sessionIdForPath(file.path)) return;
				void this.app.vault.cachedRead(file).then((content) => {
					if (content.includes("wave_id:") && this.engine.adoptIfWaveNote(file.path, content)) void this.savePersisted();
				});
			}),
		);
		this.registerEvent(
			this.app.vault.on("rename", (file: TAbstractFile, oldPath: string) => {
				if (this.engine.noteRenamed(oldPath, file.path, file instanceof TFolder)) void this.savePersisted();
			}),
		);
	}

	// --- Connecting --------------------------------------------------------------------------------

	startConnect(): void {
		const state = randomState();
		this.settings.pendingState = state;
		void this.savePersisted();
		window.open(`${AUTHORIZE_URL}?state=${encodeURIComponent(state)}`);
	}

	async finishConnect(token: string, state: string): Promise<void> {
		if (!token) return;
		if (!this.settings.pendingState || state !== this.settings.pendingState) {
			new Notice("That Wave sign-in link didn't match this vault. Start again from Settings → Wave AI.", 8000);
			return;
		}
		await this.useToken(token);
	}

	/** Store a token (from the browser flow or pasted) after checking it works. */
	async useToken(token: string): Promise<boolean> {
		const trimmed = token.trim();
		if (!trimmed) return false;
		const previous = this.settings.token;
		this.settings.token = trimmed;
		try {
			const account = await this.client.account();
			this.settings.accountEmail = account.email ?? "";
			this.settings.pendingState = "";
			if (previous !== trimmed) {
				// A different account or token: start the walk over but keep what we know about the vault.
				this.state.backfillDone = false;
				this.state.backfillCursor = null;
				this.state.newestSeen = null;
				this.state.lastError = null;
			}
			await this.savePersisted();
			new Notice(
				account.email ? `Connected to Wave as ${account.email}. Syncing ${account.session_count} recordings…` : "Connected to Wave.",
				6000,
			);
			this.settingTab?.refresh();
			void this.sync("connect");
			return true;
		} catch (error) {
			this.settings.token = previous;
			const message =
				error instanceof WaveApiError && error.code === "unauthorized"
					? "That token isn't valid. Check it at app.wave.co → Settings → Developers."
					: `Couldn't reach Wave: ${error instanceof Error ? error.message : String(error)}`;
			new Notice(message, 8000);
			return false;
		}
	}

	async disconnect(): Promise<void> {
		this.engine.abort();
		this.settings.token = "";
		this.settings.accountEmail = "";
		this.settings.pendingState = "";
		this.state.lastError = null;
		await this.savePersisted();
		this.renderStatus();
		this.settingTab?.refresh();
	}
}

const SYNC_INTERVALS: Record<string, string> = { "1": "1 minute", "5": "5 minutes", "15": "15 minutes", "60": "Hour" };

/** Settings on 1.13+ come from getSettingDefinitions (searchable); older apps get the same rows from display(). */
class WaveSettingTab extends PluginSettingTab {
	private statusEl: HTMLElement | null = null;

	constructor(app: App, private readonly plugin: WaveAIPlugin) {
		super(app, plugin);
	}

	renderStatus(): void {
		if (!this.statusEl) return;
		this.statusEl.setText(this.plugin.statusText().replace(/^Wave: /, ""));
	}

	/** Called by Obsidian 1.13+ on first show; re-rendered through update() after connect/disconnect. */
	refresh(): void {
		const self = this as unknown as { update?: () => void };
		if (typeof self.update === "function") self.update();
		else this.display();
	}

	private stringValue(key: string): string {
		const value = this.getControlValue(key);
		return typeof value === "string" || typeof value === "number" ? String(value) : "";
	}

	getControlValue(key: string): unknown {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if (key === "syncIntervalMinutes") return String(settings[key]);
		return settings[key];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		if (key === "baseFolder") settings[key] = normalizePath((typeof value === "string" ? value : "").trim() || "Wave");
		else if (key === "syncIntervalMinutes") settings[key] = Number(value) || 5;
		else settings[key] = value;
		await this.plugin.savePersisted();
		if (key === "syncIntervalMinutes") this.plugin.scheduleInterval();
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		const plugin = this.plugin;
		const connected = () => Boolean(plugin.settings.token);
		return [
			{
				type: "group",
				heading: "Account",
				items: [
					{
						name: "Connected to Wave",
						desc: "Recordings sync every few minutes while Obsidian is open, and whenever you come back to it.",
						visible: connected,
						render: (setting) => {
							setting.setName(plugin.settings.accountEmail ? `Connected as ${plugin.settings.accountEmail}` : "Connected to Wave");
							setting.addButton((button) => button.setButtonText("Sync now").onClick(() => void plugin.sync("manual")));
							setting.addButton((button) => button.setButtonText("Disconnect").onClick(() => void plugin.disconnect()));
							this.statusEl = setting.descEl.createDiv({ cls: "wave-ai-progress" });
							this.renderStatus();
						},
					},
					{
						name: "Connect your Wave account",
						desc: "Opens app.wave.co in your browser. Sign in, press Connect Obsidian, and you're done.",
						visible: () => !connected(),
						render: (setting) => {
							setting.addButton((button) => button.setCta().setButtonText("Connect Wave").onClick(() => plugin.startConnect()));
						},
					},
					{
						name: "Or paste an API token",
						desc: this.tokenHelp(),
						visible: () => !connected(),
						render: (setting) => {
							let pasted = "";
							setting.addText((text) => {
								text.inputEl.type = "password";
								text.setPlaceholder("wave_api_…").onChange((value) => {
									pasted = value;
								});
							});
							setting.addButton((button) => button.setButtonText("Save").onClick(() => void plugin.useToken(pasted)));
						},
					},
				],
			},
			{
				type: "group",
				heading: "Where notes go",
				items: [
					{ name: "Folder", desc: "Vault folder that holds your Wave notes.", control: { type: "folder", key: "baseFolder", placeholder: "Wave" } },
					{
						name: "Mirror Wave folders",
						desc: "Recordings you've put in a Wave folder land in a subfolder with the same name.",
						control: { type: "toggle", key: "mirrorFolders" },
					},
					{
						name: "File names",
						desc: "How each note is named.",
						control: { type: "dropdown", key: "fileNameStyle", options: { title: "Title only", "date-title": "2026-10-28 Title" } },
					},
				],
			},
			{
				type: "group",
				heading: "What each note contains",
				items: [
					{
						name: "Transcript",
						desc: "The full transcript sits under the summary, folded up unless you expand it.",
						control: {
							type: "dropdown",
							key: "transcript",
							options: { folded: "Included, folded", expanded: "Included, expanded", off: "Not included" },
						},
					},
					{ name: "Action items", desc: "Add Wave's action items as a task list.", control: { type: "toggle", key: "includeActionItems" } },
					{ name: "Your notes", desc: "Add the notes you typed on the recording in Wave.", control: { type: "toggle", key: "includeNotes" } },
					{
						name: "Apply content changes to existing notes",
						desc: "Re-read every recording with the options above and bring back notes you removed. Notes you've edited are never overwritten.",
						render: (setting) => {
							setting.addButton((button) =>
								button.setButtonText("Rebuild notes").onClick(() => {
									plugin.engine.scheduleRebuild();
									void plugin.sync("rebuild");
								}),
							);
						},
					},
				],
			},
			{
				type: "group",
				heading: "Syncing",
				items: [
					{
						name: "Recordings to sync",
						desc: "Older recordings are skipped. New ones always sync.",
						control: { type: "dropdown", key: "history", options: { all: "Everything", "30": "Last 30 days", "90": "Last 90 days", "365": "Last year" } },
					},
					{ name: "Check for new recordings every", control: { type: "dropdown", key: "syncIntervalMinutes", options: SYNC_INTERVALS } },
					{ name: "Sync when Obsidian opens", control: { type: "toggle", key: "syncOnStartup" } },
					{
						name: "When a recording is deleted in Wave",
						desc: "Notes you've edited always stay.",
						control: { type: "dropdown", key: "onWaveDelete", options: { keep: "Keep the note", trash: "Move the note to trash" } },
					},
					{ name: "Help", desc: this.helpText() },
					{
						name: "Something off?",
						desc: "Copies what the plugin has been doing (no token, no note contents) so Wave support can see it.",
						render: (setting) => {
							setting.addButton((button) => button.setButtonText("Copy diagnostics").onClick(() => void plugin.copyDiagnostics()));
						},
					},
				],
			},
		];
	}

	private tokenHelp(): DocumentFragment {
		return createFragment((frag) => {
			frag.appendText("Create one at ");
			frag.createEl("a", { text: "app.wave.co → Settings → Developers", href: TOKENS_SETTINGS_URL });
			frag.appendText(" with the sessions, transcripts and folders read scopes.");
		});
	}

	private helpText(): DocumentFragment {
		return createFragment((frag) => {
			frag.appendText(
				"Edit, move, rename or delete synced notes freely: Wave never writes over your changes, and nothing from your vault is sent back to Wave. ",
			);
			frag.createEl("a", { text: "Read the guide", href: HELP_URL });
			frag.appendText(".");
		});
	}

	display(): void {
		// Obsidian 1.13+ renders getSettingDefinitions() itself (and makes them searchable).
		if ("getControlValue" in PluginSettingTab.prototype) {
			super.display();
			return;
		}
		this.displayLegacy();
	}

	/** Same rows, built imperatively, for Obsidian 1.6.6 – 1.12. */
	private displayLegacy(): void {
		const { containerEl } = this;
		containerEl.empty();
		const plugin = this.plugin;
		const s = plugin.settings;
		const connected = Boolean(s.token);

		new Setting(containerEl).setName("Account").setHeading();

		if (connected) {
			const row = new Setting(containerEl)
				.setName(s.accountEmail ? `Connected as ${s.accountEmail}` : "Connected to Wave")
				.setDesc("Recordings sync every few minutes while Obsidian is open, and whenever you come back to it.");
			row.addButton((button) => button.setButtonText("Sync now").onClick(() => void plugin.sync("manual")));
			row.addButton((button) => button.setButtonText("Disconnect").onClick(() => void plugin.disconnect()));
			this.statusEl = containerEl.createDiv({ cls: "wave-ai-progress" });
			this.renderStatus();
		} else {
			new Setting(containerEl)
				.setName("Connect your Wave account")
				.setDesc("Opens app.wave.co in your browser. Sign in, press Connect Obsidian, and you're done.")
				.addButton((button) => button.setCta().setButtonText("Connect Wave").onClick(() => plugin.startConnect()));

			let pasted = "";
			new Setting(containerEl)
				.setName("Or paste an API token")
				.setDesc(this.tokenHelp())
				.addText((text) => {
					text.inputEl.type = "password";
					text.setPlaceholder("wave_api_…").onChange((value) => {
						pasted = value;
					});
				})
				.addButton((button) => button.setButtonText("Save").onClick(() => void plugin.useToken(pasted)));
		}

		const groups = this.getSettingDefinitions().slice(1) as SettingDefinitionGroup[];
		for (const group of groups) {
			new Setting(containerEl).setName(group.heading ?? "").setHeading();
			for (const item of group.items ?? []) {
				const def = item as SettingDefinition;
				const setting = new Setting(containerEl).setName(def.name);
				if (def.desc) setting.setDesc(def.desc);
				if ("render" in def && def.render) {
					def.render(setting, undefined as unknown as Parameters<typeof def.render>[1]);
					continue;
				}
				if (!("control" in def) || !def.control) continue;
				const control = def.control;
				const key = control.key;
				if (control.type === "toggle") {
					setting.addToggle((toggle) => toggle.setValue(Boolean(this.getControlValue(key))).onChange((v) => void this.setControlValue(key, v)));
				} else if (control.type === "dropdown") {
					setting.addDropdown((dropdown) =>
						dropdown.addOptions(control.options).setValue(this.stringValue(key)).onChange((v) => void this.setControlValue(key, v)),
					);
				} else if (control.type === "folder") {
					setting.addText((text) =>
						text.setPlaceholder(control.placeholder ?? "").setValue(this.stringValue(key)).onChange((v) => void this.setControlValue(key, v)),
					);
				}
			}
		}
	}
}
