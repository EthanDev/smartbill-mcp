import { withRateLimit } from "./ratelimit";
import { smbErrorFromResponse } from "./errors";
import type { FetchLike } from "./client";

const BASE_URL = "https://ws.smartbill.ro/SBORO/api";

export interface V3ClientOptions {
	/** The V3 Bearer token. If empty, V3 reads are disabled (typed error, not a raw 401). */
	token?: string;
	cif: string;
	base?: string;
	fetchFn?: FetchLike;
	sleepFn?: (ms: number) => Promise<void>;
}

/** Error returned when no V3 token is configured — typed, not a raw 401. */
export class V3NotConfiguredError extends Error {
	constructor() {
		super("V3 token not configured — V3 reads disabled");
		this.name = "V3NotConfiguredError";
	}
}

export interface SmartBillV3ClientItem {
	id?: number;
	name?: string;
	code?: string;
	description?: string;
}

/**
 * SmartBill V3 client — Bearer token for read-only entities (clients, products).
 * If no SMARTBILL_V3_TOKEN is configured, reads return a typed V3NotConfiguredError
 * instead of a raw 401 so the operator knows the feature is merely disabled.
 */
export class V3Client {
	private readonly base: string;
	private readonly fetchFn: FetchLike;
	private readonly sleepFn?: (ms: number) => Promise<void>;

	constructor(private readonly opts: V3ClientOptions) {
		this.base = opts.base ?? BASE_URL;
		this.fetchFn = opts.fetchFn ?? fetch;
		this.sleepFn = opts.sleepFn;
	}

	private requireToken(): void {
		if (!this.opts.token) throw new V3NotConfiguredError();
	}

	private async list(path: string, params: Record<string, string>): Promise<SmartBillV3ClientItem[]> {
		this.requireToken();
		const qs = new URLSearchParams(params).toString();
		const call = async (): Promise<SmartBillV3ClientItem[]> => {
			const resp = await this.fetchFn(`${this.base}${path}?${qs}`, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${this.opts.token}`,
					"Content-Type": "application/json",
				},
			});
			const rawBody = await resp.text();
			if (!resp.ok) {
				throw smbErrorFromResponse(resp.status, rawBody, resp.headers.get("retry-after") ?? undefined);
			}
			// V3 returns an object with an array field. Parse defensively.
			try {
				const parsed = JSON.parse(rawBody) as { clients?: unknown[]; products?: unknown[]; items?: unknown[] };
				return ((parsed.clients ?? parsed.products ?? parsed.items ?? []) as SmartBillV3ClientItem[]);
			} catch {
				return [];
			}
		};
		return withRateLimit(call, { sleepFn: this.sleepFn });
	}

	/** GET /v3/companies/{cif}/clients */
	listClients(cif: string, name?: string, limit?: number): Promise<SmartBillV3ClientItem[]> {
		const params: Record<string, string> = {};
		if (name) params.name = name;
		if (limit) params.limit = String(limit);
		return this.list(`/v3/companies/${cif}/clients`, params);
	}

	/** GET /v3/companies/{cif}/products */
	listProducts(cif: string, name?: string, code?: string, limit?: number): Promise<SmartBillV3ClientItem[]> {
		const params: Record<string, string> = {};
		if (name) params.name = name;
		if (code) params.code = code;
		if (limit) params.limit = String(limit);
		return this.list(`/v3/companies/${cif}/products`, params);
	}
}
