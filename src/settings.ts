export type TranscriptStyle = "folded" | "expanded" | "off";
export type HistoryRange = "all" | "30" | "90" | "365";
export type WaveDeleteBehaviour = "keep" | "trash";
export type FileNameStyle = "date-title" | "title";

export interface WaveSettings {
	/** Developer API token (wave_api_…). Empty when not connected. */
	token: string;
	/** Email shown in settings once connected. */
	accountEmail: string;
	/** CSRF state for the in-flight browser sign-in, if any. */
	pendingState: string;
	apiBaseUrl: string;
	baseFolder: string;
	mirrorFolders: boolean;
	fileNameStyle: FileNameStyle;
	transcript: TranscriptStyle;
	includeActionItems: boolean;
	includeNotes: boolean;
	history: HistoryRange;
	syncIntervalMinutes: number;
	syncOnStartup: boolean;
	onWaveDelete: WaveDeleteBehaviour;
}

export const DEFAULT_SETTINGS: WaveSettings = {
	token: "",
	accountEmail: "",
	pendingState: "",
	apiBaseUrl: "https://api.wave.co",
	baseFolder: "Wave",
	mirrorFolders: true,
	fileNameStyle: "date-title",
	transcript: "folded",
	includeActionItems: true,
	includeNotes: true,
	history: "all",
	syncIntervalMinutes: 5,
	syncOnStartup: true,
	onWaveDelete: "keep",
};

/** One synced note. `path` follows the user's moves; `managedPath` is where the plugin last put it. */
export interface NoteRecord {
	path: string;
	managedPath: string;
	hash: string;
	title: string;
	timestamp: string | null;
	durationSeconds: number;
	syncedAt: number;
}

export interface SyncState {
	notes: Record<string, NoteRecord>;
	/** Sessions the user removed from the vault. Never recreated. */
	deleted: Record<string, true>;
	/** Newest session timestamp seen; new recordings are fetched with `since`. */
	newestSeen: string | null;
	backfillCursor: string | null;
	backfillDone: boolean;
	/** Set by "Rebuild notes": the next backfill re-reads every recording instead of trusting list metadata. */
	rebuildPending: boolean;
	lastDeepRefreshAt: number | null;
	lastSyncAt: number | null;
	lastError: string | null;
}

export const DEFAULT_STATE: SyncState = {
	notes: {},
	deleted: {},
	newestSeen: null,
	backfillCursor: null,
	backfillDone: false,
	rebuildPending: false,
	lastDeepRefreshAt: null,
	lastSyncAt: null,
	lastError: null,
};

export const WAVE_APP_URL = "https://app.wave.co";
export const AUTHORIZE_URL = `${WAVE_APP_URL}/obsidian/authorize`;
export const TOKENS_SETTINGS_URL = `${WAVE_APP_URL}/settings/developers`;
export const HELP_URL = "https://help.wave.co/en/collections/wave-for-obsidian";
/** obsidian://wave-connect?token=…&state=… */
export const PROTOCOL_ACTION = "wave-connect";
