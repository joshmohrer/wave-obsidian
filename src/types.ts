// Shapes returned by the Wave Developer API (https://api.wave.co/reference).
// Only the fields the plugin reads are listed.

export interface PhoneMetadata {
	direction: "inbound" | "outbound" | null;
	to_number: string | null;
	from_number: string | null;
	status: string | null;
	ongoing: boolean;
	contact_name: string | null;
}

export interface SessionListItem {
	id: string;
	title: string;
	timestamp: string | null;
	duration_seconds: number;
	type: string;
	platform: string | null;
	phone?: PhoneMetadata;
}

export interface ActionItem {
	id: string;
	text: string;
	completed: boolean;
	assignee?: string | null;
	due_date?: string | null;
}

export interface SessionDetail extends SessionListItem {
	language: string | null;
	summary: string | null;
	notes: string | null;
	tags?: string[];
	favorite?: boolean;
	folder_ids?: string[];
	action_items?: ActionItem[];
	processing_status?: "awaiting_upload" | "fetching" | "processing" | "completed" | "failed";
}

export interface Segment {
	speaker: string;
	start: number;
	end: number;
	text: string;
}

export interface Transcript {
	id: string;
	transcript: string;
	segments?: Segment[];
}

export interface WaveFolder {
	id: string;
	name: string;
	pinned?: boolean;
	order?: number;
}

export interface SessionListResponse {
	sessions: SessionListItem[];
	next_cursor: string | null;
	has_more: boolean;
}

/** One row of POST /v1/sessions/bulk with include_summary, include_details, include_transcript and include_segments. */
export interface BulkSession extends SessionDetail {
	transcript?: string | null;
	segments?: Segment[];
}

export interface BulkResponse {
	sessions: BulkSession[];
	errors: Array<{ id: string; error: string }>;
}

export interface Account {
	user_id: string;
	email?: string;
	subscription_active: boolean;
	session_count: number;
}
