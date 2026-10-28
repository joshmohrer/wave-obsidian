import type {
	Account,
	BulkResponse,
	SessionDetail,
	SessionListResponse,
	Transcript,
	WaveFolder,
} from "./types";

export const DEFAULT_BASE_URL = "https://api.wave.co";

export type WaveErrorCode =
	| "unauthorized"
	| "forbidden"
	| "not_found"
	| "rate_limited"
	| "server_error"
	| "network"
	| "invalid_response";

export class WaveApiError extends Error {
	constructor(
		public readonly code: WaveErrorCode,
		message: string,
		public readonly status: number = 0,
		public readonly retryAfterMs: number | null = null,
	) {
		super(message);
		this.name = "WaveApiError";
	}
}

/** Minimal HTTP transport so the client can be driven by Obsidian's requestUrl or a test stub. */
export interface HttpResponse {
	status: number;
	headers: Record<string, string>;
	text: string;
}
export type HttpTransport = (req: {
	url: string;
	method: string;
	headers: Record<string, string>;
	body?: string;
}) => Promise<HttpResponse>;

function header(headers: Record<string, string>, name: string): string | undefined {
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return headers[key];
	}
	return undefined;
}

/**
 * Thin client over the Wave Developer API. Tracks the rate-limit headers so the
 * sync engine can slow down before it is told to.
 */
export class WaveClient {
	rateRemaining: number | null = null;
	/** Epoch milliseconds when the minute window resets, when known. */
	rateResetAt: number | null = null;

	constructor(
		private readonly getToken: () => string,
		private readonly transport: HttpTransport,
		private readonly baseUrl: string = DEFAULT_BASE_URL,
	) {}

	private async request<T>(
		method: "GET" | "POST",
		path: string,
		query?: Record<string, string | number | undefined>,
		body?: unknown,
	): Promise<T> {
		const token = this.getToken();
		if (!token) throw new WaveApiError("unauthorized", "Not connected to Wave", 401);

		const params = new URLSearchParams();
		for (const [key, value] of Object.entries(query ?? {})) {
			if (value !== undefined && value !== "") params.set(key, String(value));
		}
		const qs = params.toString();
		const url = `${this.baseUrl}${path}${qs ? `?${qs}` : ""}`;

		let res: HttpResponse;
		try {
			res = await this.transport({
				url,
				method,
				headers: {
					Authorization: `Bearer ${token}`,
					Accept: "application/json",
					...(body !== undefined ? { "Content-Type": "application/json" } : {}),
				},
				body: body !== undefined ? JSON.stringify(body) : undefined,
			});
		} catch (error) {
			throw new WaveApiError("network", error instanceof Error ? error.message : "Network error");
		}

		const remaining = header(res.headers, "x-ratelimit-remaining");
		if (remaining !== undefined && !Number.isNaN(Number(remaining))) this.rateRemaining = Number(remaining);
		const reset = header(res.headers, "x-ratelimit-reset");
		if (reset !== undefined && !Number.isNaN(Number(reset))) this.rateResetAt = Number(reset) * 1000;

		if (res.status >= 200 && res.status < 300) {
			try {
				return JSON.parse(res.text) as T;
			} catch {
				throw new WaveApiError("invalid_response", "Wave returned an unreadable response", res.status);
			}
		}

		let message = `Wave API error ${res.status}`;
		try {
			const parsed = JSON.parse(res.text) as { error?: { message?: string } };
			if (parsed?.error?.message) message = parsed.error.message;
		} catch {
			// keep the generic message
		}

		if (res.status === 401) throw new WaveApiError("unauthorized", message, 401);
		if (res.status === 403) throw new WaveApiError("forbidden", message, 403);
		if (res.status === 404) throw new WaveApiError("not_found", message, 404);
		if (res.status === 429) {
			const retryAfter = header(res.headers, "retry-after");
			let retryAfterMs = 15_000;
			if (retryAfter && !Number.isNaN(Number(retryAfter))) retryAfterMs = Number(retryAfter) * 1000;
			else if (this.rateResetAt) retryAfterMs = Math.max(1_000, this.rateResetAt - Date.now());
			throw new WaveApiError("rate_limited", message, 429, Math.min(retryAfterMs, 90_000));
		}
		throw new WaveApiError("server_error", message, res.status);
	}

	account(): Promise<Account> {
		return this.request<Account>("GET", "/v1/account");
	}

	listSessions(opts: { limit?: number; cursor?: string | null; since?: string | null } = {}): Promise<SessionListResponse> {
		return this.request<SessionListResponse>("GET", "/v1/sessions", {
			limit: opts.limit ?? 100,
			cursor: opts.cursor ?? undefined,
			since: opts.since ?? undefined,
		});
	}

	getSession(id: string): Promise<SessionDetail> {
		return this.request<SessionDetail>("GET", `/v1/sessions/${encodeURIComponent(id)}`);
	}

	getTranscript(id: string): Promise<Transcript> {
		return this.request<Transcript>("GET", `/v1/sessions/${encodeURIComponent(id)}/transcript`);
	}

	/** Up to 50 full recordings in one request. */
	bulkSessions(ids: string[], opts: { transcript: boolean }): Promise<BulkResponse> {
		return this.request<BulkResponse>("POST", "/v1/sessions/bulk", undefined, {
			session_ids: ids,
			include_summary: true,
			include_details: true,
			include_transcript: opts.transcript,
			include_segments: opts.transcript,
		});
	}

	async listFolders(): Promise<WaveFolder[]> {
		const res = await this.request<{ folders: WaveFolder[] }>("GET", "/v1/folders");
		return res.folders ?? [];
	}
}
