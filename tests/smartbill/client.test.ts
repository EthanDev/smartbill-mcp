import { describe, it, expect, vi } from "vitest";
import { V1Client, type FetchLike } from "../../src/smartbill/client";
import {
	SmartBillAuthError,
	SmartBillRateLimit,
	SmartBillServerError,
	SmartBillValidation,
} from "../../src/smartbill/errors";
import { withRateLimit, RATE_LIMIT_BACKOFF } from "../../src/smartbill/ratelimit";

/** Build a Response-shaped mock. */
function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), { status });
}

function captureMock(
	impl: (url: string, init?: RequestInit) => Response | Promise<Response>,
): { fn: FetchLike; calls: Array<{ url: string; init: RequestInit }> } {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	const fn: FetchLike = (url, init = {}) => {
		calls.push({ url, init });
		return Promise.resolve(impl(url, init));
	};
	return { fn, calls };
}

const EMAIL = "ethan1709@protonmail.com";
const TOKEN = "supersecrettoken";
const CIF = "RO47247261";

describe("V1Client", () => {
	it("default fetchFn invokes the global fetch with NO `this` receiver (workerd Illegal-invocation guard)", async () => {
		// Regression: `this.fetchFn = opts.fetchFn ?? fetch` then `this.fetchFn(...)`
		// binds `this` to the client — workerd's global fetch throws "Illegal
		// invocation" on a non-undefined receiver. The arrow wrapper must keep the
		// call bare. (Node's fetch tolerates `this`, so the receiver is asserted.)
		let thisAtCall: unknown = "unset";
		const stub = function (this: unknown, _url: string, _init?: RequestInit) {
			thisAtCall = this;
			return Promise.resolve(jsonResponse(200, { list: [] }));
		};
		const original = globalThis.fetch;
		(globalThis as unknown as { fetch: unknown }).fetch = stub;
		try {
			const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, base: "https://example.test" });
			await client.listSeries(CIF);
		} finally {
			(globalThis as unknown as { fetch: unknown }).fetch = original;
		}
		expect(thisAtCall).toBeUndefined();
	});

	it("serializes product price as `price` (NOT unitPrice — SmartBill rejects unitPrice)", async () => {
		const { fn, calls } = captureMock(() => jsonResponse(200, { code: 0, seriesName: "SB", number: "1" }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await client.createInvoice({
			companyVatCode: CIF,
			isDraft: true,
			client: { name: "X" },
			products: [{ name: "P", quantity: 2, price: 10, measuringUnitName: "buc", taxPercentage: 21 }],
		});
		const body = JSON.parse(calls[0].init.body as string) as {
			companyVatCode?: string;
			products: Array<Record<string, unknown>>;
		};
		expect(body.companyVatCode).toBe(CIF);
		expect(body.products[0].price).toBe(10);
		expect(body.products[0].measuringUnitName).toBe("buc");
		expect(body.products[0]).not.toHaveProperty("unitPrice");
	});

	it("sends Basic auth header = Basic base64('email:token')", async () => {
		const { fn, calls } = captureMock(() => jsonResponse(200, { code: 0, seriesName: "SB", number: "1" }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await client.createInvoice({ isDraft: true, client: { name: "X" } });
		const expected = btoa(`${EMAIL}:${TOKEN}`);
		expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Basic ${expected}`);
	});

	it("pins Accept on getPdf to the wildcard (NOT application/pdf)", async () => {
		const { fn, calls } = captureMock(() => new Response(new ArrayBuffer(0), { status: 200 }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await client.getPdf(CIF, "SB", "1");
		const headers = calls[0].init.headers as Record<string, string>;
		expect(headers.Accept).toBe("*/*");
		expect(headers.Accept).not.toBe("application/pdf");
	});

	it("getPdf hits the /invoice/pdf endpoint with cif/seriesname/number query params", async () => {
		const { fn, calls } = captureMock(() => new Response(new ArrayBuffer(0), { status: 200 }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await client.getPdf(CIF, "SB", "42");
		expect(calls[0].url).toContain("/invoice/pdf?");
		expect(calls[0].url).toContain("cif=RO47247261");
		expect(calls[0].url).toContain("seriesname=SB");
		expect(calls[0].url).toContain("number=42");
		expect(calls[0].init.method).toBe("GET");
	});

	it("maps a 401 to SmartBillAuthError", async () => {
		const { fn } = captureMock(() => jsonResponse(401, { code: 1, message: "unauthorized" }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await expect(client.paymentStatus(CIF, "SB", "1")).rejects.toBeInstanceOf(SmartBillAuthError);
	});

	it("maps a 2xx with code != 0 to SmartBillValidation with the errorText", async () => {
		const { fn } = captureMock(() => jsonResponse(200, { code: 1, message: "Seria nu exista" }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await expect(client.createInvoice({ isDraft: true })).rejects.toMatchObject({
			name: "SmartBillValidation",
			errorText: "Seria nu exista",
		});
	});

	it("maps a 5xx HTML body to SmartBillServerError (not JSON parse crash)", async () => {
		const { fn } = captureMock(() => new Response("<html>Bad Gateway</html>", { status: 502 }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await expect(client.paymentStatus(CIF, "SB", "1")).rejects.toBeInstanceOf(SmartBillServerError);
	});

	it("sendDocument base64-encodes subject and bodyText and sends companyVatCode (NOT cif)", async () => {
		const { fn, calls } = captureMock(() => jsonResponse(200, { status: { code: 0, message: "Documentul a fost trimis cu succes." } }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await client.sendDocument({ companyVatCode: CIF, type: "factura", seriesName: "SB", number: "1", to: "a@b.ro", subject: "Factura SB123", bodyText: "Salut!" });
		const sent = JSON.parse(calls[0].init.body as string) as Record<string, string>;
		expect(sent.subject).toBe(btoa("Factura SB123"));
		expect(sent.bodyText).toBe(btoa("Salut!"));
		expect(sent.companyVatCode).toBe(CIF);
		expect(sent).not.toHaveProperty("cif");
		// The raw text must NOT be sent in plaintext
		expect(JSON.stringify(sent)).not.toContain("Salut!");
		expect(JSON.stringify(sent)).not.toContain("Factura SB123");
	});

	it("sendDocument THROWS on HTTP 200 with status.code=1 (business error — email NOT sent)", async () => {
		const { fn, calls } = captureMock(() => jsonResponse(200, { status: { code: 1, message: "Server-ul de email nu a fost configurat." } }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await expect(
			client.sendDocument({ companyVatCode: CIF, type: "factura", seriesName: "SB", number: "1", to: "a@b.ro" }),
		).rejects.toThrow(/email nu a fost configurat/);
		expect(calls).toHaveLength(1);
	});

	it("cancelInvoice and restoreInvoice use PUT", async () => {
		const { fn, calls } = captureMock(() => jsonResponse(200, { code: 0 }));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await client.cancelInvoice(CIF, "SB", "1");
		await client.restoreInvoice(CIF, "SB", "1");
		expect(calls[0].init.method).toBe("PUT");
		expect(calls[1].init.method).toBe("PUT");
	});

	it("listSeries and listTax pass cif query param and unwrap the envelope", async () => {
		const { fn, calls } = captureMock(() => jsonResponse(200, {}));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		await client.listSeries(CIF, "factura");
		await client.listTax(CIF);
		expect(calls[0].url).toContain("/series?");
		expect(calls[0].url).toContain("type=factura");
		expect(calls[1].url).toContain("/tax?");
	});

	it("listSeries unwraps {list:[...]} and listTax unwraps {taxes:[...]}", async () => {
		const { fn, calls } = captureMock(() => jsonResponse(200, {}));
		const client = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn });
		// per-call bodies
		const bodies = [jsonResponse(200, { list: [{ name: "SR", type: "f" }] }), jsonResponse(200, { taxes: [{ name: "21%", percentage: 21 }] })];
		const fn2: FetchLike = () => Promise.resolve(bodies.shift() ?? jsonResponse(200, {}));
		const client2 = new V1Client({ email: EMAIL, token: TOKEN, cif: CIF, fetchFn: fn2 });
		const s = await client2.listSeries(CIF);
		const t = await client2.listTax(CIF);
		expect(s).toEqual([{ name: "SR", type: "f" }]);
		expect(t).toEqual([{ name: "21%", percentage: 21 }]);
	});
});

describe("withRateLimit", () => {
	it("retries a 429 per the ladder and throws after exhausting retries", async () => {
		const sleeps: number[] = [];
		let attempts = 0;
		const fn = vi.fn().mockImplementation(async () => {
			attempts++;
			throw new SmartBillRateLimit("blocked", undefined);
		});
		await expect(
			withRateLimit(fn, {
				backoff: RATE_LIMIT_BACKOFF,
				maxRetries: 2,
				sleepFn: async (ms) => {
					sleeps.push(ms);
				},
			}),
		).rejects.toMatchObject({ name: "SmartBillRateLimit" });
		// 2 retries allowed -> 2 sleep waits, then the final throw
		expect(sleeps).toHaveLength(2);
		expect(fn).toHaveBeenCalledTimes(3);
	});

	it("waits max(Retry-After, ladder) when Retry-After is present", async () => {
		const sleeps: number[] = [];
		let attempts = 0;
		const fn = vi.fn().mockImplementation(async () => {
			attempts++;
			if (attempts === 1) throw new SmartBillRateLimit("blocked", 30);
			return "ok";
		});
		const result = await withRateLimit(fn, {
			backoff: [5, 10],
			maxRetries: 1,
			sleepFn: async (ms) => {
				sleeps.push(ms);
			},
		});
		expect(result).toBe("ok");
		// max(30, 5) = 30s
		expect(sleeps).toEqual([30000]);
	});
});
