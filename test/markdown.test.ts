import { test } from "node:test";
import assert from "node:assert/strict";
import { buildNote, hashText, noteBaseName, pickFolder, sanitizeName, toObsidianTag } from "../src/markdown";
import type { SessionDetail, WaveFolder } from "../src/types";

const session: SessionDetail = {
	id: "sess_123",
	title: "Q4 Roadmap: Review / Plan",
	timestamp: "2026-10-13T14:30:12.000Z",
	duration_seconds: 2068,
	type: "meeting",
	platform: "google_meet",
	language: "en",
	summary: "## Q4 Roadmap Review\n\nThree bets.",
	notes: "Pre-read in Notion.",
	tags: ["work", "road map", "#q4", "2026"],
	favorite: true,
	folder_ids: ["f1"],
	action_items: [
		{ id: "a1", text: "Send legal the spec", completed: false, assignee: "JR", due_date: "2026-10-20" },
		{ id: "a2", text: "Mock up placement UI", completed: true },
	],
	processing_status: "completed",
};

const settings = { transcript: "folded" as const, includeActionItems: true, includeNotes: true };

test("sanitizeName strips characters Obsidian rejects", () => {
	assert.equal(sanitizeName('A: "B" / C | D? #tag [x] ^y'), "A\u2236 B C D tag x y");
	assert.equal(sanitizeName("1:1 — Maya"), "1\u22361 — Maya");
});

test("buildNote drops a leading summary heading that repeats the title", () => {
	const note = buildNote({ session: { ...session, title: "Product Sync", summary: "## Product Sync\n\nLocked the scope." }, folderName: null, settings, transcript: null });
	assert.match(note, /\n---\n\nLocked the scope\.\n/);
	assert.doesNotMatch(note, /## Product Sync/);
	assert.equal(sanitizeName("   "), "Untitled");
	assert.equal(sanitizeName("..hidden.."), "hidden");
	assert.equal(sanitizeName("x".repeat(300)).length, 120);
});

test("noteBaseName prefixes the local date", () => {
	const name = noteBaseName(session, "date-title");
	assert.match(name, /^\d{4}-\d{2}-\d{2} Q4 Roadmap\u2236 Review Plan$/);
	assert.equal(noteBaseName(session, "title"), "Q4 Roadmap\u2236 Review Plan");
	assert.equal(noteBaseName({ title: "No date", timestamp: null }, "date-title"), "No date");
});

test("toObsidianTag normalises tags", () => {
	assert.equal(toObsidianTag("road map"), "road-map");
	assert.equal(toObsidianTag("#q4"), "q4");
	assert.equal(toObsidianTag("2026"), null);
	assert.equal(toObsidianTag("  "), null);
});

test("pickFolder prefers pinned, then manual order, then name", () => {
	const folders = new Map<string, WaveFolder>([
		["a", { id: "a", name: "Zeta", order: 1 }],
		["b", { id: "b", name: "Alpha", order: 5 }],
		["c", { id: "c", name: "Pinned", pinned: true }],
	]);
	assert.equal(pickFolder(["a", "b", "c"], folders)?.name, "Pinned");
	assert.equal(pickFolder(["a", "b"], folders)?.name, "Zeta");
	assert.equal(pickFolder(["b", "missing"], folders)?.name, "Alpha");
	assert.equal(pickFolder(["missing"], folders), null);
	assert.equal(pickFolder(undefined, folders), null);
});

test("buildNote writes properties, summary, action items, notes and a folded transcript", () => {
	const note = buildNote({
		session,
		folderName: "Product",
		settings,
		transcript: {
			id: "sess_123",
			transcript: "Alex: Hi\nSam: Hello",
			segments: [
				{ speaker: "Alex", start: 59, end: 66, text: "Q4 roadmap." },
				{ speaker: "Alex", start: 66, end: 70, text: "Three bets." },
				{ speaker: "Sam", start: 70, end: 80, text: "Capacity is tight." },
			],
		},
	});
	assert.ok(note.startsWith("---\ntitle: \"Q4 Roadmap: Review / Plan\"\n"));
	assert.match(note, /\ndate: \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\n/);
	assert.match(note, /\nduration_minutes: 34\n/);
	assert.match(note, /\nfolder: "Product"\n/);
	assert.match(note, /\ntags:\n  - "work"\n  - "road-map"\n  - "q4"\n/);
	assert.match(note, /\nfavorite: true\n/);
	assert.match(note, /\nwave_id: "sess_123"\nwave_url: "https:\/\/app\.wave\.co\/sessions\/sess_123"\n---\n/);
	assert.match(note, /\n## Q4 Roadmap Review\n\nThree bets\.\n/);
	assert.match(note, /\n## Action items\n- \[ \] Send legal the spec \(JR\) 📅 2026-10-20\n- \[x\] Mock up placement UI\n/);
	assert.match(note, /\n## Notes\nPre-read in Notion\.\n/);
	assert.match(note, /\n> \[!quote\]- Transcript\n> \*\*Alex\*\* · 0:59\n> Q4 roadmap\. Three bets\.\n>\n> \*\*Sam\*\* · 1:10\n> Capacity is tight\.\n$/);
});

test("buildNote honours the content switches", () => {
	const note = buildNote({
		session,
		folderName: null,
		settings: { transcript: "off", includeActionItems: false, includeNotes: false },
		transcript: { id: "sess_123", transcript: "Alex: Hi" },
	});
	assert.doesNotMatch(note, /Transcript/);
	assert.doesNotMatch(note, /Action items/);
	assert.doesNotMatch(note, /## Notes/);
	assert.doesNotMatch(note, /folder:/);
	const expanded = buildNote({ session, folderName: null, settings: { ...settings, transcript: "expanded" }, transcript: { id: "x", transcript: "Alex: Hi\n\n\nSam: Yo" } });
	assert.match(expanded, /> \[!quote\]\+ Transcript\n> Alex: Hi\n>\n> Sam: Yo\n$/);
});

test("buildNote falls back when there is no summary", () => {
	const note = buildNote({ session: { ...session, summary: null }, folderName: null, settings, transcript: null });
	assert.match(note, /\n---\n\n_No summary yet\._\n\n## Action items\n/);
});

test("hashText is stable", () => {
	assert.equal(hashText("hello"), hashText("hello"));
	assert.notEqual(hashText("hello"), hashText("hello "));
});
