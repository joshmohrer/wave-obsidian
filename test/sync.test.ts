import { test } from "node:test";
import assert from "node:assert/strict";
import { WaveClient, type HttpResponse, type HttpTransport } from "../src/api";
import { DEFAULT_SETTINGS, DEFAULT_STATE, type SyncState, type WaveSettings } from "../src/settings";
import { SyncEngine, waveIdOf, type VaultIO } from "../src/sync";
import { hashText, normaliseForHash } from "../src/markdown";
import type { SessionDetail, SessionListItem, Transcript, WaveFolder } from "../src/types";

class MemoryVault implements VaultIO {
	files = new Map<string, string>();
	folders = new Set<string>();
	trashed: string[] = [];
	async exists(path: string) {
		return this.files.has(path) || this.folders.has(path);
	}
	async read(path: string) {
		const v = this.files.get(path);
		if (v === undefined) throw new Error(`missing ${path}`);
		return v;
	}
	async create(path: string, content: string) {
		if (this.files.has(path)) throw new Error(`exists ${path}`);
		this.files.set(path, content);
	}
	async modify(path: string, content: string) {
		if (!this.files.has(path)) throw new Error(`missing ${path}`);
		this.files.set(path, content);
	}
	async rename(from: string, to: string) {
		const v = this.files.get(from);
		if (v === undefined) throw new Error(`missing ${from}`);
		this.files.delete(from);
		this.files.set(to, v);
	}
	async trash(path: string) {
		this.files.delete(path);
		this.trashed.push(path);
	}
	async ensureFolder(path: string) {
		if (path) this.folders.add(path);
	}
}

interface FakeWave {
	sessions: SessionDetail[];
	transcripts: Record<string, Transcript>;
	folders: WaveFolder[];
	requests: string[];
	rateRemaining: number;
}

function fakeTransport(wave: FakeWave): HttpTransport {
	const json = (status: number, body: unknown): HttpResponse => ({
		status,
		headers: { "x-ratelimit-remaining": String(wave.rateRemaining), "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) },
		text: JSON.stringify(body),
	});
	return async (req) => {
		const url = new URL(req.url);
		wave.requests.push(`${req.method} ${url.pathname}${url.search}`);
		const sorted = [...wave.sessions].sort((a, b) => (b.timestamp ?? "").localeCompare(a.timestamp ?? ""));
		if (url.pathname === "/v1/account") return json(200, { user_id: "u1", email: "demo@wave.co", subscription_active: true, session_count: wave.sessions.length });
		if (url.pathname === "/v1/folders") return json(200, { folders: wave.folders });
		if (url.pathname === "/v1/sessions") {
			const limit = Number(url.searchParams.get("limit") ?? 20);
			const cursor = url.searchParams.get("cursor");
			const since = url.searchParams.get("since");
			const filtered = sorted.filter((s) => (!cursor || (s.timestamp ?? "") < cursor) && (!since || (s.timestamp ?? "") > since));
			const page = filtered.slice(0, limit);
			const hasMore = filtered.length > limit;
			const items: SessionListItem[] = page.map(({ id, title, timestamp, duration_seconds, type, platform }) => ({ id, title, timestamp, duration_seconds, type, platform }));
			return json(200, { sessions: items, next_cursor: hasMore ? page[page.length - 1].timestamp : null, has_more: hasMore });
		}
		const m = url.pathname.match(/^\/v1\/sessions\/([^/]+)(\/transcript)?$/);
		if (m) {
			const id = decodeURIComponent(m[1]);
			const s = wave.sessions.find((x) => x.id === id);
			if (!s) return json(404, { error: { code: "not_found", message: "Session not found" } });
			if (m[2]) {
				const t = wave.transcripts[id];
				return t ? json(200, t) : json(404, { error: { code: "not_found", message: "No transcript" } });
			}
			return json(200, s);
		}
		return json(500, { error: { code: "internal_error", message: "unhandled" } });
	};
}

function makeSession(n: number, extra: Partial<SessionDetail> = {}): SessionDetail {
	return {
		id: `s${n}`,
		title: `Session ${n}`,
		timestamp: new Date(Date.UTC(2026, 9, 1 + n, 12, 0, 0)).toISOString(),
		duration_seconds: 600 + n,
		type: "meeting",
		platform: null,
		language: "en",
		summary: `Summary ${n}`,
		notes: null,
		tags: [],
		favorite: false,
		folder_ids: [],
		action_items: [],
		processing_status: "completed",
		...extra,
	};
}

function harness(opts: { sessions?: SessionDetail[]; settings?: Partial<WaveSettings>; state?: Partial<SyncState>; folders?: WaveFolder[] } = {}) {
	const wave: FakeWave = {
		sessions: opts.sessions ?? [makeSession(1), makeSession(2), makeSession(3)],
		transcripts: {},
		folders: opts.folders ?? [],
		requests: [],
		rateRemaining: 50,
	};
	for (const s of wave.sessions) wave.transcripts[s.id] = { id: s.id, transcript: `Alex: hello from ${s.id}` };
	const settings: WaveSettings = { ...DEFAULT_SETTINGS, token: "wave_api_test", ...(opts.settings ?? {}) };
	const state: SyncState = { ...DEFAULT_STATE, notes: {}, deleted: {}, ...(opts.state ?? {}) };
	const vault = new MemoryVault();
	let saves = 0;
	const client = new WaveClient(() => settings.token, fakeTransport(wave));
	const engine = new SyncEngine({
		client,
		io: vault,
		settings: () => settings,
		state,
		save: async () => {
			saves += 1;
		},
		sleep: async () => {},
		now: () => Date.parse("2026-10-28T12:00:00Z"),
	});
	return { wave, settings, state, vault, engine, saves: () => saves };
}

test("first sync creates one note per recording, newest first, and remembers them", async () => {
	const h = harness();
	const result = await h.engine.run("manual");
	assert.equal(result?.created, 3);
	assert.equal(h.state.backfillDone, true);
	assert.equal(h.state.newestSeen, h.wave.sessions[2].timestamp);
	assert.deepEqual([...h.vault.files.keys()].sort(), ["Wave/2026-10-02 Session 1.md", "Wave/2026-10-03 Session 2.md", "Wave/2026-10-04 Session 3.md"]);
	assert.match(h.vault.files.get("Wave/2026-10-04 Session 3.md") ?? "", /Summary 3/);
	assert.match(h.vault.files.get("Wave/2026-10-04 Session 3.md") ?? "", /hello from s3/);
	assert.equal(Object.keys(h.state.notes).length, 3);
});

test("second sync is cheap and changes nothing", async () => {
	const h = harness();
	await h.engine.run("manual");
	h.wave.requests.length = 0;
	const result = await h.engine.run("interval");
	assert.equal(result?.created, 0);
	assert.equal(result?.updated, 0);
	// one folders call, one list call, no per-session reads
	assert.deepEqual(h.wave.requests, ["GET /v1/folders", "GET /v1/sessions?limit=100"]);
});

test("new recordings and renamed recordings are picked up", async () => {
	const h = harness();
	await h.engine.run("manual");
	h.wave.sessions.push(makeSession(9));
	h.wave.transcripts.s9 = { id: "s9", transcript: "new one" };
	h.wave.sessions[0].title = "Session 1 renamed";
	const result = await h.engine.run("interval");
	assert.equal(result?.created, 1);
	assert.equal(result?.updated, 1);
	assert.ok(h.vault.files.has("Wave/2026-10-10 Session 9.md"));
	assert.ok(h.vault.files.has("Wave/2026-10-02 Session 1 renamed.md"));
	assert.ok(!h.vault.files.has("Wave/2026-10-02 Session 1.md"));
	assert.equal(h.state.notes.s1.path, "Wave/2026-10-02 Session 1 renamed.md");
});

test("a note the user edited is never overwritten, but keeps following metadata", async () => {
	const h = harness();
	await h.engine.run("manual");
	const path = "Wave/2026-10-02 Session 1.md";
	h.vault.files.set(path, `${h.vault.files.get(path)}\nMy own thoughts.\n`);
	h.wave.sessions[0].summary = "Summary 1 regenerated";
	h.wave.sessions[0].duration_seconds = 999; // changes list metadata so the engine looks again
	const result = await h.engine.run("interval");
	assert.equal(result?.keptEdits, 1);
	assert.match(h.vault.files.get(path) ?? "", /My own thoughts/);
	assert.doesNotMatch(h.vault.files.get(path) ?? "", /regenerated/);
	assert.equal(h.state.notes.s1.durationSeconds, 999);
});

test("a note the user deleted stays deleted", async () => {
	const h = harness();
	await h.engine.run("manual");
	const path = "Wave/2026-10-03 Session 2.md";
	h.vault.files.delete(path);
	h.engine.noteDeleted(path, false);
	assert.equal(h.state.deleted.s2, true);
	await h.engine.run("interval");
	assert.ok(!h.vault.files.has(path));
	h.engine.scheduleRebuild();
	await h.engine.run("rebuild");
	assert.ok(!h.vault.files.has(path));
});

test("a note the user moved is updated in place and never moved back", async () => {
	const h = harness();
	await h.engine.run("manual");
	const from = "Wave/2026-10-03 Session 2.md";
	const to = "Archive/Session two.md";
	await h.vault.rename(from, to);
	h.engine.noteRenamed(from, to, false);
	h.wave.sessions[1].title = "Session 2 renamed";
	const result = await h.engine.run("interval");
	assert.equal(result?.updated, 1);
	assert.ok(h.vault.files.has(to));
	assert.match(h.vault.files.get(to) ?? "", /title: "Session 2 renamed"/);
	assert.ok(!h.vault.files.has("Wave/2026-10-03 Session 2 renamed.md"));
});

test("renaming a folder in the vault keeps tracking every note inside it", async () => {
	const h = harness();
	await h.engine.run("manual");
	for (const [p, v] of [...h.vault.files]) {
		h.vault.files.delete(p);
		h.vault.files.set(p.replace(/^Wave\//, "Meetings/"), v);
	}
	h.engine.noteRenamed("Wave", "Meetings", true);
	assert.equal(h.state.notes.s1.path, "Meetings/2026-10-02 Session 1.md");
	const result = await h.engine.run("interval");
	assert.equal(result?.created, 0);
});

test("Wave folders become subfolders and follow the recording", async () => {
	const h = harness({
		folders: [{ id: "f-hiring", name: "Hiring", pinned: true }, { id: "f-product", name: "Product/Design" }],
		sessions: [makeSession(1, { folder_ids: ["f-product"] }), makeSession(2, { folder_ids: ["f-product", "f-hiring"] }), makeSession(3)],
	});
	await h.engine.run("manual");
	assert.ok(h.vault.files.has("Wave/Product Design/2026-10-02 Session 1.md"));
	assert.ok(h.vault.files.has("Wave/Hiring/2026-10-03 Session 2.md"));
	assert.ok(h.vault.files.has("Wave/2026-10-04 Session 3.md"));
	// Moved to another folder in Wave → the note follows (list metadata unchanged, so trigger a rebuild)
	h.wave.sessions[0].folder_ids = ["f-hiring"];
	h.engine.scheduleRebuild();
	await h.engine.run("rebuild");
	assert.ok(h.vault.files.has("Wave/Hiring/2026-10-02 Session 1.md"));
	assert.ok(!h.vault.files.has("Wave/Product Design/2026-10-02 Session 1.md"));
});

test("a recording deleted in Wave is confirmed before anything happens", async () => {
	const h = harness({ settings: { onWaveDelete: "trash" } });
	await h.engine.run("manual");
	h.wave.sessions.splice(1, 1); // s2 gone
	const result = await h.engine.run("interval");
	assert.equal(result?.removed, 1);
	assert.deepEqual(h.vault.trashed, ["Wave/2026-10-03 Session 2.md"]);
	assert.equal(h.state.notes.s2, undefined);
	assert.ok(h.wave.requests.some((r) => r === "GET /v1/sessions/s2"));
});

test("with keep (default) a recording deleted in Wave leaves its note alone", async () => {
	const h = harness();
	await h.engine.run("manual");
	h.wave.sessions.splice(1, 1);
	await h.engine.run("interval");
	assert.ok(h.vault.files.has("Wave/2026-10-03 Session 2.md"));
	assert.deepEqual(h.vault.trashed, []);
	assert.equal(h.state.notes.s2, undefined);
});

test("an edited note is not trashed even when Wave deleted the recording", async () => {
	const h = harness({ settings: { onWaveDelete: "trash" } });
	await h.engine.run("manual");
	const path = "Wave/2026-10-03 Session 2.md";
	h.vault.files.set(path, "edited");
	h.wave.sessions.splice(1, 1);
	await h.engine.run("interval");
	assert.ok(h.vault.files.has(path));
});

test("history range stops the backfill at the cutoff", async () => {
	const sessions = [makeSession(1, { timestamp: "2025-01-01T00:00:00.000Z" }), makeSession(2, { timestamp: "2026-10-20T00:00:00.000Z" })];
	const h = harness({ sessions, settings: { history: "30" } });
	const result = await h.engine.run("manual");
	assert.equal(result?.created, 1);
	assert.equal(h.state.backfillDone, true);
});

test("backfill resumes across passes when aborted", async () => {
	const sessions = Array.from({ length: 7 }, (_, i) => makeSession(i + 1));
	const h = harness({ sessions });
	let created = 0;
	const originalCreate = h.vault.create.bind(h.vault);
	h.vault.create = async (p, c) => {
		await originalCreate(p, c);
		created += 1;
		if (created === 2) h.engine.abort();
	};
	const first = await h.engine.run("manual");
	assert.equal(first?.aborted, true);
	assert.equal(h.state.backfillDone, false);
	const second = await h.engine.run("manual");
	assert.equal(second?.aborted, false);
	assert.equal(h.vault.files.size, 7);
	assert.equal(h.state.backfillDone, true);
});

test("colliding titles get a short id suffix instead of overwriting", async () => {
	const h = harness({ sessions: [makeSession(1, { timestamp: "2026-10-05T10:00:00.000Z", title: "Standup" }), makeSession(2, { timestamp: "2026-10-05T18:00:00.000Z", title: "Standup" })] });
	await h.engine.run("manual");
	assert.deepEqual([...h.vault.files.keys()].sort(), ["Wave/2026-10-05 Standup (s1).md", "Wave/2026-10-05 Standup.md"]);
});

test("unchanged content is not rewritten", async () => {
	const h = harness();
	await h.engine.run("manual");
	const path = "Wave/2026-10-02 Session 1.md";
	const stored = h.state.notes.s1.hash;
	assert.equal(hashText(normaliseForHash(h.vault.files.get(path) ?? "")), stored);
	h.engine.scheduleRebuild();
	const result = await h.engine.run("rebuild");
	assert.equal(result?.unchanged, 3);
	assert.equal(result?.updated, 0);
});

test("a note that reappears with its wave_id is adopted, not duplicated", async () => {
	const h = harness();
	await h.engine.run("manual");
	// Renamed in Finder: Obsidian sees a delete and a create.
	const from = "Wave/2026-10-03 Session 2.md";
	const to = "Wave/Session two (mine).md";
	const content = h.vault.files.get(from) ?? "";
	h.vault.files.delete(from);
	h.engine.noteDeleted(from, false);
	assert.equal(h.state.deleted.s2, true);
	h.vault.files.set(to, content);
	assert.equal(h.engine.adoptIfWaveNote(to, content), true);
	assert.equal(h.state.deleted.s2, undefined);
	assert.equal(h.state.notes.s2.path, to);
	h.wave.sessions[1].title = "Session 2 renamed";
	const result = await h.engine.run("interval");
	assert.equal(result?.updated, 1);
	assert.equal(result?.created, 0);
	assert.match(h.vault.files.get(to) ?? "", /Session 2 renamed/);
	assert.equal(h.vault.files.size, 3);
});

test("a note another device already wrote at the target path is adopted", async () => {
	const h = harness();
	await h.engine.run("manual");
	// Fresh plugin state (new device), same vault contents.
	const h2 = harness();
	h2.vault.files = new Map(h.vault.files);
	h2.vault.folders = new Set(h.vault.folders);
	const result = await h2.engine.run("manual");
	assert.equal(result?.created, 0);
	assert.equal(h2.vault.files.size, 3);
	assert.equal(Object.keys(h2.state.notes).length, 3);
});

test("waveIdOf reads only the frontmatter", () => {
	assert.equal(waveIdOf('---\ntitle: "x"\nwave_id: "abc-1"\n---\nbody wave_id: "zzz"\n'), "abc-1");
	assert.equal(waveIdOf("no frontmatter wave_id: \"zzz\""), null);
});

test("an invalid token stops the pass with an unauthorized error", async () => {
	const h = harness();
	h.settings.token = "";
	assert.equal(await h.engine.run("manual"), null);
});
