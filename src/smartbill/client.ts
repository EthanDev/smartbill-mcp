import { withRateLimit, withReadThrottle } from "./ratelimit";
import { SmartBillValidation, smbErrorFromResponse } from "./errors";
import type {
	SmartBillCreateInvoiceBody,
	SmartBillDocumentResponse,
	SmartBillPaymentBody,
	SmartBillPaymentStatusResponse,
	SmartBillSendDocumentBody,
	SmartBillSeriesItem,
	SmartBillTaxItem,
} from "./types";

const BASE_URL = "https://ws.smartbill.ro/SBORO/api";

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface V1ClientOptions {
	email: string;
	token: string;
	cif: string;
	base?: string;
	/** Injectable fetch for tests. */
	fetchFn?: FetchLike;
	/** Injectable rate-limiter wait fn. */
	sleepFn?: (ms: number) => Promise<void>;
}

interface ApiErrorBody {
	code?: number;
	message?: string;
	errorText?: string;
}

/**
 * SmartBill V1 client — Basic auth (email + API token) for the document lifecycle.
 * On any non-2xx, or a 2xx whose body has `code != 0`, throws a typed error.
 */
export class V1Client {
	private readonly base: string;
	private readonly fetchFn: FetchLike;
	private readonly sleepFn?: (ms: number) => Promise<void>;
	// Token-bucket for read tools (V1 30 calls/10s then a hard 10-min block).
	// We deliberately throttle reads to >=1s spacing and cap concurrency.
	private readonly lastReadAt = { time: 0 };

	constructor(private readonly opts: V1ClientOptions) {
		this.base = opts.base ?? BASE_URL;
		// Arrow wrapper (not the bare global): workerd's `fetch` throws "Illegal
		// invocation" when called with a `this` receiver (e.g. this.fetchFn(...)).
		this.fetchFn = opts.fetchFn ?? ((url, init) => fetch(url, init));
		this.sleepFn = opts.sleepFn;
	}

	private authHeaders(): HeadersInit {
		const auth = btoa(`${this.opts.email}:${this.opts.token}`);
		return {
			Authorization: `Basic ${auth}`,
			"Content-Type": "application/json",
		};
	}

	private async requestJSON<T>(path: string, init: RequestInit, retryable = true): Promise<T> {
		const call = async (): Promise<T> => {
			const resp = await this.fetchFn(this.base + path, init);
			const rawBody = await resp.text();
			if (!resp.ok) {
				throw smbErrorFromResponse(resp.status, rawBody, resp.headers.get("retry-after") ?? undefined);
			}
			if (!rawBody) return {} as T;
			const parsed = JSON.parse(rawBody) as ApiErrorBody & T;
			// SmartBill returns `code != 0` together with a 2xx status for API-level errors.
			if (typeof parsed.code === "number" && parsed.code !== 0) {
				throw new SmartBillValidation(400, rawBody, parsed.message || parsed.errorText);
			}
			return parsed;
		};
		return retryable ? withRateLimit(call, { sleepFn: this.sleepFn }) : call();
	}

	private async requestRaw(path: string, init: RequestInit): Promise<ArrayBuffer> {
		const call = async (): Promise<ArrayBuffer> => {
			const resp = await this.fetchFn(this.base + path, init);
			if (!resp.ok) {
				const rawBody = await resp.text();
				throw smbErrorFromResponse(resp.status, rawBody, resp.headers.get("retry-after") ?? undefined);
			}
			return await resp.arrayBuffer();
		};
		return withRateLimit(call, { sleepFn: this.sleepFn });
	}

	private async throttledRead<T>(path: string, init: RequestInit): Promise<T> {
		return withReadThrottle(() => this.requestJSON<T>(path, init, true), this.lastReadAt);
	}

	/** POST /invoice/v2 — create a draft (isDraft:true) or a final invoice. */
	createInvoice(body: SmartBillCreateInvoiceBody): Promise<SmartBillDocumentResponse> {
		return this.requestJSON("/invoice/v2", {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(body),
		});
	}

	/** GET /invoice/pdf — returns the raw PDF bytes. MUST send the wildcard Accept header (default application/pdf -> 406). */
	getPdf(cif: string, seriesname: string, number: string): Promise<ArrayBuffer> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.requestRaw(`/invoice/pdf?${qs}`, {
			method: "GET",
			headers: {
				Authorization: `Basic ${btoa(`${this.opts.email}:${this.opts.token}`)}`,
				Accept: "*/*",
			},
		});
	}

	/** POST /document/send — email a document. subject/bodyText are base64-encoded per spec. */
	sendDocument(body: SmartBillSendDocumentBody): Promise<SmartBillDocumentResponse & { code?: number }> {
		const payload: SmartBillSendDocumentBody = {
			...body,
			subject: body.subject ? btoa(body.subject) : undefined,
			bodyText: body.bodyText ? btoa(body.bodyText) : undefined,
		};
		return this.requestJSON("/document/send", {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(payload),
		});
	}

	/** GET /invoice/paymentstatus */
	paymentStatus(cif: string, seriesname: string, number: string): Promise<SmartBillPaymentStatusResponse> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.throttledRead(`/invoice/paymentstatus?${qs}`, { method: "GET", headers: this.authHeaders() });
	}

	/** POST /payment — record a payment. */
	recordPayment(body: SmartBillPaymentBody): Promise<SmartBillDocumentResponse> {
		return this.requestJSON("/payment", {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(body),
		});
	}

	/** PUT /invoice/cancel */
	cancelInvoice(cif: string, seriesname: string, number: string): Promise<SmartBillDocumentResponse> {
		const qs = new URLSearchParams({ cif, seriesName: seriesname, number }).toString();
		return this.requestJSON(`/invoice/cancel?${qs}`, { method: "PUT", headers: this.authHeaders() });
	}

	/** PUT /invoice/restore */
	restoreInvoice(cif: string, seriesname: string, number: string): Promise<SmartBillDocumentResponse> {
		const qs = new URLSearchParams({ cif, seriesName: seriesname, number }).toString();
		return this.requestJSON(`/invoice/restore?${qs}`, { method: "PUT", headers: this.authHeaders() });
	}

	/** POST /invoice/reverse — storno. */
	storno(body: { cif: string; seriesName: string; number: string; type?: string }): Promise<SmartBillDocumentResponse> {
		return this.requestJSON("/invoice/reverse", {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(body),
		});
	}

	/** GET /series — list document series (optionally filtered by type). Unwraps the {list:[...]} envelope. */
	async listSeries(cif: string, type?: string): Promise<SmartBillSeriesItem[]> {
		const qs = new URLSearchParams({ cif });
		if (type) qs.set("type", type);
		const res = await this.throttledRead<{ list?: SmartBillSeriesItem[] }>(`/series?${qs.toString()}`, {
			method: "GET",
			headers: this.authHeaders(),
		});
		return res.list ?? [];
	}

	/** GET /tax — list configured tax rates. Unwraps the {taxes:[...]} envelope. */
	async listTax(cif: string): Promise<SmartBillTaxItem[]> {
		const qs = new URLSearchParams({ cif }).toString();
		const res = await this.throttledRead<{ taxes?: SmartBillTaxItem[] }>(`/tax?${qs}`, {
			method: "GET",
			headers: this.authHeaders(),
		});
		return res.taxes ?? [];
	}
}
