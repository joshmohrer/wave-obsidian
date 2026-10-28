import type { SessionDetail, Transcript, WaveFolder } from "./types";
import type { WaveSettings } from "./settings";
import { WAVE_APP_URL } from "./settings";

/** Fast non-cryptographic string hash (cyrb53). Used to detect user edits. */
export function hashText(str: string, seed = 0): string {
	let h1 = 0xdeadbeef ^ seed;
	let h2 = 0x41c6ce57 ^ seed;
	for (let i = 0; i < str.length; i++) {
		const ch = str.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
	h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
	h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16);
}

/** Normalise line endings so a file Obsidian re-saved still hashes the same. */
export function normaliseForHash(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\s+$/, "");
}

const FORBIDDEN = /[\\/:*?"<>|#^[\]]/g;

/** A file or folder name Obsidian accepts on every platform. */
export function sanitizeName(raw: string, fallback = "Untitled"): string {
	let name = (raw ?? "")
		.replace(FORBIDDEN, " ")
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, " ")
		.trim()
		.replace(/^\.+|[. ]+$/g, "");
	if (name.length > 120) name = name.slice(0, 120).trim();
	return name || fallback;
}

function pad(n: number): string {
	return n < 10 ? `0${n}` : String(n);
}

/** Local calendar date (YYYY-MM-DD) of an ISO timestamp, or null. */
export function localDate(timestamp: string | null): string | null {
	if (!timestamp) return null;
	const d = new Date(timestamp);
	if (Number.isNaN(d.getTime())) return null;
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Local date-time without zone, the form Obsidian's date & time property understands. */
export function localDateTime(timestamp: string | null): string | null {
	if (!timestamp) return null;
	const d = new Date(timestamp);
	if (Number.isNaN(d.getTime())) return null;
	return `${localDate(timestamp)}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export function noteBaseName(session: { title: string; timestamp: string | null }, style: WaveSettings["fileNameStyle"]): string {
	const title = sanitizeName(session.title, "Untitled recording");
	const date = localDate(session.timestamp);
	if (style === "title" || !date) return title;
	return `${date} ${title}`;
}

/** The Wave folder a session should live under: pinned first, then manual order, then name. */
export function pickFolder(folderIds: string[] | undefined, folders: Map<string, WaveFolder>): WaveFolder | null {
	if (!folderIds?.length) return null;
	const candidates = folderIds.map((id) => folders.get(id)).filter((f): f is WaveFolder => Boolean(f));
	if (!candidates.length) return null;
	candidates.sort((a, b) => {
		if (Boolean(a.pinned) !== Boolean(b.pinned)) return a.pinned ? -1 : 1;
		const ao = a.order ?? Number.MAX_SAFE_INTEGER;
		const bo = b.order ?? Number.MAX_SAFE_INTEGER;
		if (ao !== bo) return ao - bo;
		return a.name.localeCompare(b.name);
	});
	return candidates[0];
}

function yamlString(value: string): string {
	return JSON.stringify(value);
}

function yamlList(values: string[]): string {
	if (!values.length) return "[]";
	return `\n${values.map((v) => `  - ${yamlString(v)}`).join("\n")}`;
}

/** Obsidian tags cannot contain spaces or start with a digit-only token. */
export function toObsidianTag(tag: string): string | null {
	const cleaned = tag.trim().replace(/^#+/, "").replace(/\s+/g, "-").replace(/[^\p{L}\p{N}_\-/]/gu, "");
	if (!cleaned || /^\d+$/.test(cleaned)) return null;
	return cleaned;
}

function formatClock(seconds: number): string {
	const s = Math.max(0, Math.floor(seconds));
	const h = Math.floor(s / 3600);
	const m = Math.floor((s % 3600) / 60);
	const sec = s % 60;
	return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function transcriptLines(transcript: Transcript): string[] {
	const segments = transcript.segments ?? [];
	if (segments.length) {
		const lines: string[] = [];
		let speaker: string | null = null;
		let parts: string[] = [];
		let start = 0;
		const flush = () => {
			if (speaker === null || !parts.length) return;
			lines.push(`**${speaker}** · ${formatClock(start)}`);
			lines.push(parts.join(" "));
			lines.push("");
		};
		for (const seg of segments) {
			const text = (seg.text ?? "").trim();
			if (!text) continue;
			if (seg.speaker !== speaker) {
				flush();
				speaker = seg.speaker || "Speaker";
				parts = [];
				start = seg.start ?? 0;
			}
			parts.push(text);
		}
		flush();
		while (lines.length && lines[lines.length - 1] === "") lines.pop();
		return lines;
	}
	return (transcript.transcript ?? "")
		.replace(/\r\n/g, "\n")
		.split("\n")
		.map((line) => line.trimEnd());
}

export interface BuildNoteInput {
	session: SessionDetail;
	transcript: Transcript | null;
	folderName: string | null;
	settings: Pick<WaveSettings, "transcript" | "includeActionItems" | "includeNotes">;
	appUrl?: string;
}

/** The full Markdown file for one recording: properties on top, summary, action items, notes, transcript. */
export function buildNote(input: BuildNoteInput): string {
	const { session, transcript, folderName, settings } = input;
	const appUrl = input.appUrl ?? WAVE_APP_URL;
	const fm: string[] = ["---"];
	fm.push(`title: ${yamlString(session.title || "Untitled recording")}`);
	const when = localDateTime(session.timestamp);
	if (when) fm.push(`date: ${when}`);
	fm.push(`duration_minutes: ${Math.max(0, Math.round((session.duration_seconds ?? 0) / 60))}`);
	if (session.type) fm.push(`type: ${yamlString(session.type)}`);
	if (session.platform) fm.push(`platform: ${yamlString(session.platform)}`);
	if (session.language) fm.push(`language: ${yamlString(session.language)}`);
	if (folderName) fm.push(`folder: ${yamlString(folderName)}`);
	const tags = (session.tags ?? []).map(toObsidianTag).filter((t): t is string => Boolean(t));
	if (tags.length) fm.push(`tags:${yamlList(tags)}`);
	if (session.favorite) fm.push("favorite: true");
	if (session.type === "phone" && session.phone) {
		const number = session.phone.direction === "inbound" ? session.phone.from_number : session.phone.to_number;
		if (session.phone.contact_name) fm.push(`contact: ${yamlString(session.phone.contact_name)}`);
		if (number) fm.push(`phone_number: ${yamlString(number)}`);
		if (session.phone.direction) fm.push(`call_direction: ${yamlString(session.phone.direction)}`);
	}
	fm.push(`wave_id: ${yamlString(session.id)}`);
	fm.push(`wave_url: ${yamlString(`${appUrl}/sessions/${encodeURIComponent(session.id)}`)}`);
	fm.push("---");

	const blocks: string[] = [fm.join("\n")];

	const summary = (session.summary ?? "").replace(/\r\n/g, "\n").trim();
	if (summary) blocks.push(summary);
	else blocks.push("_No summary yet._");

	if (settings.includeActionItems && session.action_items?.length) {
		const lines = ["## Action items"];
		for (const item of session.action_items) {
			const text = (item.text ?? "").replace(/\s+/g, " ").trim();
			if (!text) continue;
			let line = `- [${item.completed ? "x" : " "}] ${text}`;
			if (item.assignee) line += ` (${item.assignee})`;
			if (item.due_date) line += ` 📅 ${item.due_date}`;
			lines.push(line);
		}
		if (lines.length > 1) blocks.push(lines.join("\n"));
	}

	const notes = (session.notes ?? "").replace(/\r\n/g, "\n").trim();
	if (settings.includeNotes && notes) blocks.push(`## Notes\n${notes}`);

	if (settings.transcript !== "off" && transcript) {
		const lines = transcriptLines(transcript).filter((_, i, arr) => !(arr[i] === "" && arr[i - 1] === ""));
		if (lines.some((l) => l.trim())) {
			const marker = settings.transcript === "folded" ? "-" : "+";
			const body = lines.map((line) => (line ? `> ${line}` : ">")).join("\n");
			blocks.push(`> [!quote]${marker} Transcript\n${body}`);
		}
	}

	return `${blocks.join("\n\n")}\n`;
}
