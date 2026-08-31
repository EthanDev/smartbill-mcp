import { withRateLimit, withReadThrottle } from "./ratelimit";
import { SmartBillValidation, smbErrorFromResponse } from "./errors";
import type {
	SmartBillCreateInvoiceBody,
	SmartBillDocumentResponse,
	SmartBillEstimateInvoicesResponse,
	SmartBillPaymentBody,
	SmartBillPaymentStatusResponse,
	SmartBillSendDocumentBody,
	SmartBillSeriesItem,
	SmartBillStockItem,
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

	/** POST /document/send — email a document. subject/bodyText are base64-encoded per spec.
	 *  Business errors come as HTTP 200 with `{ status: { code: 1, message } }` (no errorText) —
	 *  this method surfaces them as SmartBillValidation so a failed email is never reported as sent. */
	async sendDocument(body: SmartBillSendDocumentBody): Promise<SmartBillDocumentResponse & { status?: { code: number; message: string } }> {
		const payload: SmartBillSendDocumentBody = {
			...body,
			subject: body.subject ? btoa(body.subject) : undefined,
			bodyText: body.bodyText ? btoa(body.bodyText) : undefined,
		};
		const res = await this.requestJSON<SmartBillDocumentResponse & { status?: { code: number; message: string } }>("/document/send", {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(payload),
		});
		if (res.status && typeof res.status.code === "number" && res.status.code !== 0) {
			throw new SmartBillValidation(400, JSON.stringify(res), res.status.message || "SmartBill email send failed");
		}
		return res;
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
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.requestJSON(`/invoice/cancel?${qs}`, { method: "PUT", headers: this.authHeaders() });
	}

	/** PUT /invoice/restore */
	restoreInvoice(cif: string, seriesname: string, number: string): Promise<SmartBillDocumentResponse> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.requestJSON(`/invoice/restore?${qs}`, { method: "PUT", headers: this.authHeaders() });
	}

	/** POST /invoice/reverse — storno. Body uses companyVatCode (NOT cif). */
	storno(body: { companyVatCode: string; seriesName: string; number: string; issueDate?: string }): Promise<SmartBillDocumentResponse> {
		return this.requestJSON("/invoice/reverse", {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(body),
		});
	}

	/** POST /estimate/v2 — emit a proforma (quote). Body shape mirrors invoice creation. */
	createEstimate(body: SmartBillCreateInvoiceBody): Promise<SmartBillDocumentResponse> {
		return this.requestJSON("/estimate/v2", {
			method: "POST",
			headers: this.authHeaders(),
			body: JSON.stringify(body),
		});
	}

	/** GET /estimate/invoices — check whether a proforma was invoiced. */
	estimateInvoices(cif: string, seriesname: string, number: string): Promise<SmartBillEstimateInvoicesResponse> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.throttledRead(`/estimate/invoices?${qs}`, { method: "GET", headers: this.authHeaders() });
	}

	/** GET /estimate/pdf — proforma PDF. Accept header caveat like invoice pdf. */
	getEstimatePdf(cif: string, seriesname: string, number: string): Promise<ArrayBuffer> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.requestRaw(`/estimate/pdf?${qs}`, {
			method: "GET",
			headers: { ...this.authHeaders(), Accept: "*/*" },
		});
	}

	/** PUT /estimate/cancel */
	cancelEstimate(cif: string, seriesname: string, number: string): Promise<SmartBillDocumentResponse> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.requestJSON(`/estimate/cancel?${qs}`, { method: "PUT", headers: this.authHeaders() });
	}

	/** PUT /estimate/restore */
	restoreEstimate(cif: string, seriesname: string, number: string): Promise<SmartBillDocumentResponse> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.requestJSON(`/estimate/restore?${qs}`, { method: "PUT", headers: this.authHeaders() });
	}

	/** DELETE /estimate — delete a proforma (only the last in the series). */
	deleteEstimate(cif: string, seriesname: string, number: string): Promise<SmartBillDocumentResponse> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.requestJSON(`/estimate?${qs}`, { method: "DELETE", headers: this.authHeaders() });
	}

	/** DELETE /invoice — delete an invoice (only the last in the series). */
	deleteInvoice(cif: string, seriesname: string, number: string): Promise<SmartBillDocumentResponse> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.requestJSON(`/invoice?${qs}`, { method: "DELETE", headers: this.authHeaders() });
	}

	/** GET /stocks — stock levels. `date` is REQUIRED (yyyy-MM-dd); filters are case-sensitive. Unwraps the {list:[...]} envelope. */
	async listStocks(cif: string, date: string, filters?: { warehouseName?: string; productName?: string; productCode?: string }): Promise<SmartBillStockItem[]> {
		const qs = new URLSearchParams({ cif, date });
		if (filters?.warehouseName) qs.set("warehouseName", filters.warehouseName);
		if (filters?.productName) qs.set("productName", filters.productName);
		if (filters?.productCode) qs.set("productCode", filters.productCode);
		const res = await this.throttledRead<{ list?: SmartBillStockItem[] }>(`/stocks?${qs.toString()}`, { method: "GET", headers: this.authHeaders() });
		return res.list ?? [];
	}

	/** GET /payment/text — fiscal receipt data (bon fiscal only; `id` from creation). */
	paymentText(cif: string, id: string): Promise<Record<string, unknown>> {
		const qs = new URLSearchParams({ cif, id }).toString();
		return this.throttledRead(`/payment/text?${qs}`, { method: "GET", headers: this.authHeaders() });
	}

	/** DELETE /payment/chitanta — delete a receipt (only the last in the series). */
	deleteChitanta(cif: string, seriesname: string, number: string): Promise<SmartBillDocumentResponse> {
		const qs = new URLSearchParams({ cif, seriesname, number }).toString();
		return this.requestJSON(`/payment/chitanta?${qs}`, { method: "DELETE", headers: this.authHeaders() });
	}

	/** DELETE /payment/v2 — delete a non-receipt payment (paymentType is case-sensitive at delete). */
	deletePayment(cif: string, params: { paymentType: string; invoiceSeries?: string; invoiceNumber?: string; paymentDate?: string; paymentValue?: number; clientName?: string; clientCif?: string }): Promise<SmartBillDocumentResponse> {
		const qs = new URLSearchParams({ cif, paymentType: params.paymentType });
		if (params.invoiceSeries) qs.set("invoiceSeries", params.invoiceSeries);
		if (params.invoiceNumber) qs.set("invoiceNumber", params.invoiceNumber);
		if (params.paymentDate) qs.set("paymentDate", params.paymentDate);
		if (params.paymentValue != null) qs.set("paymentValue", String(params.paymentValue));
		if (params.clientName) qs.set("clientName", params.clientName);
		if (params.clientCif) qs.set("clientCif", params.clientCif);
		return this.requestJSON(`/payment/v2?${qs.toString()}`, { method: "DELETE", headers: this.authHeaders() });
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
