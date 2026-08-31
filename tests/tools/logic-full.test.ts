import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { AuthUser, Env } from "../../src/env";
import {
	createDraft,
	finalize,
	sendInvoice,
	recordPayment,
	cancel,
	storno,
	invoiceStatus,
	pdf,
	series,
	tax,
	clients,
	products,
	search,
	totals,
	syncLedger,
	createEstimate,
	estimateInvoices,
	estimatePdf,
	estimateCancel,
	estimateRestore,
	invoiceDelete,
	stocks,
	paymentDelete,
	convertProforma,
	clientBalancesTool,
	overdueTool,
	dueInvoicesTool,
	registerAccount,
} from "../../src/tools/logic";

const KEY = "a".repeat(64);

/**
 * SQL-aware FakeDB. Supports the exact statements the ledger module issues:
 * SELECT ... FROM <t> WHERE <conds> (first/all), INSERT INTO <t> (cols) VALUES (?),
 * UPDATE <t> SET col = ? WHERE <conds>. Conditions are positional predicates:
 *   col = ? | col != ? | col >= ? | col <= ? | col IS NULL | col LIKE ?
 * OR groups (client_name LIKE ? OR client_cif LIKE ?) consume args in order.
 */
export type Row = Record<string, unknown>;
export class FakeDB {
	tenants: Row[] = [];
	invoices: Row[] = [];
	audit_events: Row[] = [];
	nextId = 1;
	private lastInsertId: number | null = null;
	private sql = "";
	private args: unknown[] = [];

	prepare(sql: string) {
		this.sql = sql;
		return this;
	}
	bind(...args: unknown[]) {
		this.args = args;
		return this;
	}

	private conds(): Array<{ col: string; op: string; argIdx: number | null; or: boolean; values?: string[] }> {
		let where = (this.sql.split("WHERE")[1] ?? "").replace(/\s+ORDER\s+BY\s+[\w\s,]+/i, "").replace(/\s+LIMIT\s+\d+/i, "");
		// Split on AND / OR at top level; predicates reference `col OP ?`, `col IS NULL`, or `col IN ('a','b')`.
		const parts = where.split(/\b(AND|OR)\b/).map((p) => p.trim());
		const conds: Array<{ col: string; op: string; argIdx: number | null; or: boolean; values?: string[] }> = [];
		let argIdx = 0;
		let i = 0;
		while (i < parts.length) {
			const isOr = parts[i] === "OR";
			if (parts[i] === "AND" || parts[i] === "OR") {
				i++;
				continue;
			}
			let expr = parts[i];
			// strip outer parens
			while (expr.startsWith("(") && expr.endsWith(")")) expr = expr.slice(1, -1).trim();
			const inM = expr.match(/^([\w()'%_,.-]+)\s+IN\s*\(\s*('(?:[^']*)'(?:\s*,\s*'(?:[^']*)')*)\s*\)$/i);
			if (inM) {
				const values = (inM[2].match(/'([^']*)'/g) ?? []).map((v) => v.slice(1, -1));
				conds.push({ col: inM[1].replace(/[()'%]/g, ""), op: "IN", argIdx: null, or: isOr, values });
				i++;
				continue;
			}
			const lirM = expr.match(/^([\w()'%_,.-]+)\s*=\s*last_insert_rowid\(\)$/i);
			if (lirM) {
				conds.push({ col: lirM[1].replace(/[()'%]/g, ""), op: "LAST_INSERT", argIdx: null, or: isOr });
				i++;
				continue;
			}
			// multi-column OR group like `(a LIKE ? OR b LIKE ?)` is split by the AND/OR splitter already
			const m = expr.match(/^([\w()'%_,.-]+)\s*(=|!=|>=|<=|LIKE|IS NULL)(?:\s+\?)?$/i);
			if (!m) {
				i++;
				continue;
			}
			const col = m[1].replace(/^strftime\('%Y-%m',\s*(\w+)\)$/, "$1").replace(/[()'%]/g, "");
			const op = m[2].toUpperCase();
			if (op === "IS NULL") {
				conds.push({ col, op, argIdx: null, or: isOr });
			} else {
				conds.push({ col, op, argIdx: argIdx++, or: isOr });
			}
			i++;
		}
		return conds;
	}

	private matches(row: Row): boolean {
		const conds = this.conds();
		if (conds.length === 0) return true;
		let result = true;
		for (const c of conds) {
			const val = row[c.col];
			let ok: boolean;
			if (c.op === "IS NULL") {
				ok = val == null;
			} else if (c.op === "IN") {
				ok = (c.values ?? []).includes(String(val ?? ""));
			} else if (c.op === "LAST_INSERT") {
				ok = Number(val) === this.lastInsertId;
			} else {
				const arg = this.args[c.argIdx!];
				if (c.op === "LIKE") {
					const pat = String(arg).replace(/%/g, ".*");
					ok = new RegExp(`^${pat}$`).test(String(val ?? ""));
				} else if (c.op === ">=") {
					ok = String(val ?? "") >= String(arg);
				} else if (c.op === "<=") {
					ok = String(val ?? "") <= String(arg);
				} else if (c.op === "!=") {
					ok = String(val ?? "") !== String(arg);
				} else {
					ok = String(val ?? "") === String(arg);
				}
			}
			if (c.or) result = result || ok;
			else result = result && ok;
		}
		return result;
	}

	private table(): string {
		const m = this.sql.match(/(?:FROM|INTO|UPDATE)\s+(\w+)/);
		return m?.[1] ?? "";
	}

	async first(): Promise<Row | null> {
		const t = this.table();
		const rows = (this as unknown as Record<string, Row[]>)[t] ?? [];
		// Aggregations: COALESCE(SUM(x),0) AS a, COUNT(*) AS b  (and COUNT(*) AS n)
		const sumM = this.sql.match(/SUM\(\s*(\w+)\s*\)[\s\S]*?AS\s+(\w+)/);
		const countM = this.sql.match(/COUNT\(\s*\*\s*\)[\s\S]*?AS\s+(\w+)/);
		if (sumM || countM) {
			const rows2 = rows.filter((r) => this.matches(r));
			const out: Row = {};
			if (sumM) {
				const [ , sumCol, sumAlias ] = sumM;
				out[sumAlias] = rows2.reduce((s, r) => s + (Number(r[sumCol]) || 0), 0);
			}
			if (countM) out[countM[1]] = rows2.length;
			return out;
		}
		return rows.filter((r) => this.matches(r))[0] ?? null;
	}

	async all(): Promise<{ results: Row[] }> {
		const t = this.table();
		const rows = (this as unknown as Record<string, Row[]>)[t] ?? [];
		const filtered = rows.filter((r) => this.matches(r));
		if (this.sql.includes("GROUP BY")) {
			// GROUP BY <col> with SUM(x) AS a / COUNT(*) AS n -> [{ col: value, a: sum, n: count }]
			const gbM = this.sql.match(/GROUP BY\s+(\w+)/);
			if (gbM) {
				const col = gbM[1];
				const sums = [...this.sql.matchAll(/COALESCE\(\s*SUM\(\s*(\w+)\s*\)[^)]*\)\s*AS\s+(\w+)|SUM\(\s*(\w+)\s*\)\s*AS\s+(\w+)/gi)].map((m) => ({ src: m[1] ?? m[3], alias: m[2] ?? m[4] }));
				const nM = this.sql.match(/COUNT\(\s*\*\s*\)\s*AS\s+(\w+)/);
				const counts = new Map<string, { sums: Record<string, number>; n: number }>();
				for (const r of filtered) {
					const key = String(r[col] ?? "unknown");
					const entry = counts.get(key) ?? { sums: {}, n: 0 };
					for (const s of sums) entry.sums[s.alias] = (entry.sums[s.alias] ?? 0) + (Number(r[s.src]) || 0);
					if (nM) entry.n += 1;
					counts.set(key, entry);
				}
				return { results: [...counts.entries()].map(([k, v]) => ({ [col]: k, ...v.sums, ...(nM ? { [nM[1]]: v.n } : {}) })) };
			}
		}
		if (this.sql.includes("ORDER BY created_at DESC")) {
			filtered.sort((a, b) => String(b.created_at ?? "").localeCompare(String(a.created_at ?? "")));
		}
		return { results: filtered.slice(0, 100) };
	}

	async run(): Promise<{ success: boolean; meta?: { last_row_id: number } }> {
		if (this.sql.startsWith("INSERT")) {
			const cols = (this.sql.match(/\(([^)]+)\)\s*VALUES/) ?? [])[1]?.split(",").map((c) => c.trim()) ?? [];
			const valuePart = this.sql.split("VALUES")[1] ?? "";
			// Match bound args in order; skip literal expressions like datetime('now') so col<->arg alignment holds.
			const valueToks = valuePart.match(/\(([^)]*)\)/)?.[1].split(",").map((t) => t.trim()) ?? [];
			const row: Row = { id: this.nextId++ };
			let ai = 0;
			cols.forEach((c, i) => {
				const tok = valueToks[i] ?? "";
				if (tok === "?") row[c] = this.args[ai++];
			});
			this.lastInsertId = row.id as number;
			if (!("created_at" in row)) row.created_at = "2026-08-29 10:00:00";
			if (!("updated_at" in row)) row.updated_at = "2026-08-29 10:00:00";
			(this as unknown as Record<string, Row[]>)[this.table()].push(row);
			return { success: true, meta: { last_row_id: row.id as number } };
		}
		if (this.sql.startsWith("UPDATE")) {
			const setPart = this.sql.split(/\s+WHERE\s+/i)[0].replace(/^UPDATE\s+\w+\s+SET\s+/i, "");
			const sets = setPart.split(",").map((s) => s.trim());
			// Each SET item is `col = ?` (bound arg), `col = 'literal'`, or `col = COALESCE(?, col)` (bound-if-non-null).
			const setItems: Array<{ col: string; bound: boolean; literal?: string }> = sets.map((s) => {
				const bound = s.match(/^(\w+)\s*=\s*\?$/);
				const coalesce = s.match(/^(\w+)\s*=\s*COALESCE\(\s*\?\s*,\s*(\w+)\s*\)$/);
				const lit = s.match(/^(\w+)\s*=\s*'([^']*)'$/);
				if (bound) return { col: bound[1], bound: true };
				if (coalesce) return { col: coalesce[1], bound: true, coalesce: true } as never;
				if (lit) return { col: lit[1], bound: false, literal: lit[2] };
				return { col: s.split("=")[0]?.trim(), bound: false, literal: "1" };
			}).filter((s) => s.col);
			const boundCount = setItems.filter((s) => s.bound).length;
			const setArgs = this.args.slice(0, boundCount);
			const whereArgs = this.args.slice(boundCount);
			const rows = (this as unknown as Record<string, Row[]>)[this.table()] ?? [];
			for (const r of rows) {
				// evaluate WHERE with the tail args
				const saved = this.args;
				this.args = whereArgs;
				const m = this.matches(r);
				this.args = saved;
				if (m) {
					let bi = 0;
					for (const item of setItems) {
						const v = item.bound ? setArgs[bi++] : item.literal;
						if ((item as { coalesce?: boolean }).coalesce && v === null) continue;
						r[item.col] = v;
					}
					r.updated_at = "2026-08-29 10:00:00";
				}
			}
			return { success: true };
		}
		return { success: true };
	}
}

export function makeEnv(v3Token?: string): { env: Env; db: FakeDB } {
	const db = new FakeDB();
	const env = {
		DB: db as unknown as D1Database,
		OAUTH_KV: {} as KVNamespace,
		SMARTBILL_EMAIL: "ethan1709@protonmail.com",
		SMARTBILL_TOKEN: "003|token123",
		SMARTBILL_CIF: "RO47247261",
		SMARTBILL_CIF_FALLBACK: "47247261",
		SMARTBILL_V3_TOKEN: v3Token,
		GITHUB_CLIENT_ID: "c",
		GITHUB_CLIENT_SECRET: "s",
		COOKIE_ENCRYPTION_KEY: "k",
		ENCRYPTION_KEY: KEY,
		OWNER_GITHUB_LOGIN: "EthanDev",
		ALLOWED_GITHUB_LOGINS: "EthanDev",
	} as Env;
	return { env, db };
}

export const owner: AuthUser = { login: "EthanDev", email: "e@a.ro", name: "Ethan" };

/** Route fetch stubs by URL fragment, mirroring the live SmartBill API shapes. */
function stubSmartBill(overrides: Record<string, unknown> = {}) {
	const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
		const u = String(url);
		if (u.includes("/series")) return new Response(JSON.stringify({ list: [{ name: "SR", type: "f" }, { name: "SRP", type: "p" }] }), { status: 200 });
		if (u.includes("/tax")) return new Response(JSON.stringify({ taxes: [{ name: "Normala", percentage: 21 }] }), { status: 200 });
		if (u.includes("/invoice/pdf")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, { status: 200 });
		if (u.includes("/estimate/pdf")) return new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]).buffer, { status: 200 });
		if (u.includes("/estimate/invoices")) return new Response(JSON.stringify({ areInvoicesCreated: true, invoices: [{ series: "SR", number: "77" }] }), { status: 200 });
		if (u.includes("/invoice/paymentstatus")) return new Response(JSON.stringify({ paid: overrides.paid ?? false }), { status: 200 });
		if (u.includes("/invoice/v2")) return new Response(JSON.stringify({ code: 0, seriesName: "SR", number: String(overrides.nextNumber ?? "1") }), { status: 200 });
		if (u.includes("/invoice/reverse")) return new Response(JSON.stringify({ code: 0, seriesName: "SR", number: "9" }), { status: 200 });
		if (u.includes("/invoice/cancel")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
		if (u.includes("/invoice/restore")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
		if (u.includes("/estimate/v2")) return new Response(JSON.stringify({ code: 0, seriesName: "SRP", number: "5" }), { status: 200 });
		if (u.includes("/estimate/cancel")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
		if (u.includes("/estimate/restore")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
		if (u.includes("/estimate?")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
		if (u.includes("/stocks")) return new Response(JSON.stringify({ list: [{ warehouseName: "Depozit", productName: "Widget", quantity: 12 }] }), { status: 200 });
		if (u.includes("/payment/text")) return new Response(JSON.stringify({ text: "BON" }), { status: 200 });
		if (u.includes("/payment/chitanta")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
		if (u.includes("/payment/v2")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
		if (u.includes("/payment")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
		if (u.includes("/document/send")) return new Response(JSON.stringify({ code: 0 }), { status: 200 });
		if (u.includes("/v3/")) return new Response(JSON.stringify({ items: [] }), { status: 401 });
		return new Response(JSON.stringify({ code: 0 }), { status: 200 });
	});
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

async function seedDraft(env: Env, db: FakeDB, extra?: Record<string, unknown>): Promise<Row> {
	const res = await createDraft(env, owner, {
		client: { name: "ACME", city: "Bucuresti", country: "Romania" },
		products: [{ name: "Widget", quantity: 1, unitPrice: 10, isTaxIncluded: false, taxName: "Normala", taxPercentage: 21 }],
		series: "SR",
		currency: "RON",
		...extra,
	});
	const m = res.content[0].text.match(/draft_id (\S+)/);
	if (!m) throw new Error(`no draft_id in: ${res.content[0].text}`);
	const row = db.invoices.find((r) => r.draft_id === m[1])!;
	return row;
}

describe("create_draft", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("creates a draft row with status draft and the wire body uses price/companyVatCode/measuringUnitName", async () => {
		const { env, db } = makeEnv();
		const row = await seedDraft(env, db);
		expect(row.status).toBe("draft");
		expect(row.series).toBe("SR");
		expect(row.client_name).toBe("ACME");
		expect(row.total_ron).toBe(10);
		expect(String(row.draft_payload)).toContain('"price":10');
		expect(String(row.draft_payload)).toContain('"companyVatCode":"RO47247261"');
		expect(String(row.draft_payload)).toContain('"measuringUnitName":"buc"');
		expect(String(row.draft_payload)).not.toContain("unitPrice");
	});

	it("dedupes on idempotency_key", async () => {
		const { env, db } = makeEnv();
		const r1 = await seedDraft(env, db, { idempotency_key: "k1" });
		await seedDraft(env, db, { idempotency_key: "k1" });
		expect(db.invoices.length).toBe(1);
		expect(r1.draft_id).toBeTruthy();
	});

	it("defaults taxName to SmartBill tax names (Normala/Redusa) not percentage strings", async () => {
		const { env, db } = makeEnv();
		await createDraft(env, owner, {
			client: { name: "ACME", country: "Romania" },
			products: [{ name: "W", quantity: 1, unitPrice: 10 }],
			series: "SR",
		});
		await createDraft(env, owner, {
			client: { name: "ACME", country: "Romania" },
			products: [{ name: "W2", quantity: 1, unitPrice: 10, taxPercentage: 11 }],
			series: "SR",
		});
		const payloads = db.invoices.map((r) => String(r.draft_payload));
		expect(payloads.some((p) => p.includes('"taxName":"Normala"'))).toBe(true);
		expect(payloads.some((p) => p.includes('"taxName":"Redusa"'))).toBe(true);
		expect(payloads.some((p) => p.includes('"taxName":"21%"'))).toBe(false);
	});

	it("requires a client name", async () => {
		const { env } = makeEnv();
		await expect(createDraft(env, owner, { products: [{ name: "W", quantity: 1, unitPrice: 10 }] })).rejects.toThrow(/client/);
	});

	it("rejects a draft with no product lines (agent must ask before drafting)", async () => {
		const { env } = makeEnv();
		await expect(createDraft(env, owner, { client: { name: "ACME" } })).rejects.toThrow(/at least one product line/);
	});

	it("rejects a draft with a line missing quantity or unit price (agent must ask)", async () => {
		const { env } = makeEnv();
		await expect(createDraft(env, owner, { client: { name: "ACME" }, products: [{ name: "W", unitPrice: 10 }] }))
			.rejects.toThrow(/needs a quantity/);
		await expect(createDraft(env, owner, { client: { name: "ACME" }, products: [{ name: "W", quantity: 1 }] }))
			.rejects.toThrow(/needs a unit price/);
	});
});

describe("series/tax (V1 reads)", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("list_series unwraps the envelope and exposes the name as seriesname", async () => {
		const { env } = makeEnv();
		const res = await series(env, owner, {});
		expect(res.content[0].text).toContain('"seriesname":"SR"');
	});

	it("list_tax unwraps the taxes envelope", async () => {
		const { env } = makeEnv();
		const res = await tax(env, owner);
		expect(res.content[0].text).toContain('"name":"Normala"');
	});
});

describe("finalize_invoice", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("finalizes a draft: number NULL -> real, status draft -> issued, audit written", async () => {
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db);
		expect(draft.number).toBeNull();
		const res = await finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		expect(res.content[0].text).toMatch(/finalized: SR\/1/);
		const row = db.invoices.find((r) => r.id === draft.id)!;
		expect(row.status).toBe("issued");
		expect(row.number).toBe("1");
		expect(db.audit_events.some((a) => a.event === "finalized")).toBe(true);
	});

	it("rejects finalizing an already-finalized draft", async () => {
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db);
		await finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		await expect(finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true })).rejects.toThrow(/already issued/);
	});

	it("rejects a missing draft", async () => {
		const { env } = makeEnv();
		await expect(finalize(env, owner, { draft_id: "nope", confirm: true })).rejects.toThrow(/not found/);
	});
});

describe("send_invoice", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("resolves the recipient from the draft payload and sends", async () => {
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db, { client: { name: "ACME", email: "acme@x.ro" } });
		await finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		const res = await sendInvoice(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		expect(res.content[0].text).toContain("acme@x.ro");
		expect(db.audit_events.some((a) => a.event === "sent")).toBe(true);
	});

	it("requires a recipient", async () => {
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db);
		await finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		await expect(sendInvoice(env, owner, { draft_id: draft.draft_id as string, confirm: true })).rejects.toThrow(/recipient/);
	});
});

describe("record_payment / cancel / storno", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("record_payment flips the ledger to paid and audits", async () => {
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db);
		await finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		const res = await recordPayment(env, owner, { series: "SR", number: "1", type: "Card", value: 12.1, currency: "RON", confirm: true });
		expect(res.content[0].text).toContain("recorded");
		expect(db.invoices.find((r) => r.id === draft.id)!.status).toBe("paid");
		expect(db.invoices.find((r) => r.id === draft.id)!.paid_ron).toBe(12.1);
		expect(db.audit_events.some((a) => a.event === "payment:12.1")).toBe(true);
	});

	it("record_payment accumulates partial payments without flipping until fully paid", async () => {
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db);
		await finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		await recordPayment(env, owner, { series: "SR", number: "1", type: "Card", value: 4, currency: "RON", confirm: true });
		const row = db.invoices.find((r) => r.id === draft.id)!;
		expect(row.paid_ron).toBe(4);
		expect(row.status).toBe("issued"); // NOT paid yet (total is 10)
		await recordPayment(env, owner, { series: "SR", number: "1", type: "Card", value: 6, currency: "RON", confirm: true });
		const row2 = db.invoices.find((r) => r.id === draft.id)!;
		expect(row2.paid_ron).toBe(10);
		expect(row2.status).toBe("paid");
	});

	it("cancel_invoice flips the ledger to cancelled", async () => {
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db);
		await finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		await cancel(env, owner, { series: "SR", number: "1", confirm: true });
		expect(db.invoices.find((r) => r.id === draft.id)!.status).toBe("cancelled");
	});

	it("storno flips the ledger to storno (searchable)", async () => {
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db);
		await finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		await storno(env, owner, { series: "SR", number: "1", confirm: true });
		expect(db.invoices.find((r) => r.id === draft.id)!.status).toBe("storno");
		const res = await search(env, owner, { status: "storno" });
		expect(res.content[0].text).toContain('"status":"storno"');
	});
});

describe("invoice_status", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("self-heals a draft to issued when SmartBill has a number", async () => {
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db);
		// smartbill returns isPaid false; ledger row draft with no number
		await invoiceStatus(env, owner, { series: "SR", number: "1" });
		const row = db.invoices.find((r) => r.id === draft.id)!;
		expect(row.status).toBe("issued");
		expect(row.number).toBe("1");
	});

	it("mirrors live paid state into the ledger", async () => {
		stubSmartBill({ paid: true });
		const { env, db } = makeEnv();
		const draft = await seedDraft(env, db);
		await finalize(env, owner, { draft_id: draft.draft_id as string, confirm: true });
		const res = await invoiceStatus(env, owner, { series: "SR", number: "1" });
		expect(res.content[0].text).toContain("ledger=paid");
		expect(res.content[0].text).toContain("paid=true");
		expect(db.invoices.find((r) => r.id === draft.id)!.status).toBe("paid");
	});
});

describe("get_pdf", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("returns base64 of the PDF with %PDF magic", async () => {
		const { env } = makeEnv();
		const res = await pdf(env, owner, { series: "SR", number: "1" });
		expect(res.content[0].text).toContain("PDF (base64");
		expect(res.content[0].text).toContain("JVBERg=="); // %PDF
	});
});

describe("search_invoices / count_totals", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("filters by status and client", async () => {
		const { env, db } = makeEnv();
		await seedDraft(env, db);
		await seedDraft(env, db, { client: { name: "OTHER", city: "X", country: "Romania" } });
		const res = await search(env, owner, { client: "ACME" });
		expect(res.content[0].text).toContain("ACME");
		expect(res.content[0].text).not.toContain("OTHER");
	});

	it("count_totals sums RON per status", async () => {
		const { env, db } = makeEnv();
		await seedDraft(env, db);
		await seedDraft(env, db);
		const res = await totals(env, owner, { status: "draft" });
		expect(res.content[0].text).toContain("Count: 2");
		expect(res.content[0].text).toContain("Sum: 20 RON");
	});

	it("count_totals answers 'how many invoices do I have' conversationally with a status breakdown", async () => {
		const { env, db } = makeEnv();
		await seedDraft(env, db);
		await seedDraft(env, db);
		const res = await totals(env, owner, {});
		expect(res.content[0].text).toContain("You have 2 invoice(s) in your ledger");
		expect(res.content[0].text).toContain("draft: 2");
		expect(res.content[0].text).toContain("Sum total: 20 RON");
	});

	it("count_totals filters by date range (from/to) and client", async () => {
		const { env, db } = makeEnv();
		await seedDraft(env, db, { issueDate: "2026-02-10" });
		await seedDraft(env, db, { issueDate: "2026-08-10" });
		const res = await totals(env, owner, { from: "2026-07-01", to: "2026-08-31", client: "ACME" });
		expect(res.content[0].text).toContain("Count: 1");
		expect(res.content[0].text).toContain("Sum: 10 RON");
	});
});

describe("list_clients / list_products (V3)", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("returns a typed V3-not-configured message instead of a raw 401 when no token", async () => {
		const { env } = makeEnv();
		const res = await clients(env, owner, {});
		expect(res.content[0].text).toContain("V3 token not configured");
		const res2 = await products(env, owner, {});
		expect(res2.content[0].text).toContain("V3 token not configured");
	});

	it("with SMARTBILL_V3_TOKEN set, list_clients sends Bearer auth and returns clients", async () => {
		// /v3/... paths return 401 in the default stub — replace it for this test.
		vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
			const u = String(url);
			if (u.includes("/v3/companies/RO47247261/clients")) {
				const auth = (init?.headers as Record<string, string>)?.Authorization ?? "";
				expect(auth).toBe("Bearer sb_live_v3test");
				return new Response(JSON.stringify({
					items: [{ id: "cus_01a0477feddf75d3bdd45768cab63904", name: "SPEED FIRE PROTECTION SRL", vatCode: "RO29534899" }],
					pagination: { next: null, previous: null },
				}), { status: 200 });
			}
			if (u.includes("/series")) return new Response(JSON.stringify({ list: [{ name: "SR", type: "f" }] }), { status: 200 });
			return new Response(JSON.stringify({ items: [] }), { status: 200 });
		}));
		const { env } = makeEnv("sb_live_v3test");
		const res = await clients(env, owner, {});
		expect(res.content[0].text).toContain("SPEED FIRE PROTECTION SRL");
		expect(res.content[0].text).toContain("RO29534899");
	});
});

describe("register_account", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("probes creds live then registers the tenant (encrypted at rest)", async () => {
		const { env, db } = makeEnv();
		const res = await registerAccount(env, owner, {
			email: "other@x.ro",
			token: "003|newtoken",
			cif: "RO99999999",
		});
		expect(res.content[0].text).toContain("registered");
		const tenant = db.tenants.find((t) => t.user_id === "EthanDev")!;
		expect(String(tenant.token_enc)).not.toContain("newtoken");
		expect(String(tenant.token_enc).length).toBeGreaterThan(10);
		expect(db.audit_events.some((a) => a.event === "register_attempt")).toBe(true);
	});

	it("sync_ledger upserts external rows and updates on re-sync", async () => {
		const { env, db } = makeEnv();
		const r1 = await syncLedger(env, owner, {
			rows: [{ series: "SR", number: "0100", clientName: "ACME", totalRon: 100, status: "issued" }],
		});
		expect(r1.content[0].text).toContain("1 inserted");
		const r2 = await syncLedger(env, owner, {
			rows: [{ series: "SR", number: "0100", clientName: "ACME", totalRon: 150, status: "paid" }],
		});
		expect(r2.content[0].text).toContain("1 updated");
		const row = db.invoices.find((r) => r.number === "0100");
		expect(row?.status).toBe("paid");
		expect(row?.total_ron).toBe(150);
	});

	it("client_balances aggregates issued/paid/outstanding per client", async () => {
		const { env, db } = makeEnv();
		await syncLedger(env, owner, { rows: [
			{ series: "SR", number: "1", clientName: "ACME", totalRon: 100, status: "issued" },
			{ series: "SR", number: "2", clientName: "ACME", totalRon: 50, status: "paid" },
			{ series: "SR", number: "3", clientName: "OTHER", totalRon: 200, status: "issued" },
		]});
		const res = await clientBalancesTool(env, owner);
		const text = res.content[0].text;
		expect(text).toContain("ACME");
		expect(text).toContain("issued 150");
		expect(text).toContain("OTHER");
	});

	it("overdue_invoices reports past-due with aging buckets", async () => {
		const { env, db } = makeEnv();
		await syncLedger(env, owner, { rows: [
			{ series: "SR", number: "1", clientName: "ACME", totalRon: 100, issueDate: "2026-01-01", dueDate: "2026-01-31", status: "issued" },
			{ series: "SR", number: "2", clientName: "ACME", totalRon: 50, issueDate: "2026-07-01", dueDate: "2026-08-01", status: "paid" },
		]});
		const res = await overdueTool(env, owner, {});
		const text = res.content[0].text;
		expect(text).toContain("Overdue: 1 invoice(s)");
		expect(text).toContain("SR/1");
		expect(text).toContain("90+");
	});

	it("due_invoices finds invoices by due_date window (not issue_date)", async () => {
		const { env, db } = makeEnv();
		await syncLedger(env, owner, { rows: [
			{ series: "SR", number: "1", clientName: "ACME", totalRon: 100, issueDate: "2026-01-01", dueDate: "2026-08-15", status: "issued" },
			{ series: "SR", number: "2", clientName: "BETA", totalRon: 50, issueDate: "2026-08-01", dueDate: "2026-12-31", status: "issued" },
		]});
		const res = await dueInvoicesTool(env, owner, { from: "2026-08-01", to: "2026-08-31" });
		const text = res.content[0].text;
		expect(text).toContain("1 invoice(s) due");
		expect(text).toContain("SR/1");
		expect(text).not.toContain("SR/2");
	});

	it("count_totals reports per-currency sums when mixed", async () => {
		const { env, db } = makeEnv();
		await syncLedger(env, owner, { rows: [
			{ series: "SR", number: "1", clientName: "ACME", totalRon: 100, currency: "RON", status: "issued" },
			{ series: "SR", number: "2", clientName: "ACME", totalRon: 50, currency: "EUR", status: "issued" },
		]});
		const res = await totals(env, owner, {});
		const text = res.content[0].text;
		expect(text).toContain("by currency");
		expect(text).toContain("EUR");
	});

	it("throttles to 5 attempts/hour", async () => {
		const { env, db } = makeEnv();
		for (let i = 0; i < 5; i++) {
			db.audit_events.push({ id: i, invoice_id: null, user_id: "EthanDev", event: "register_attempt", actor: "EthanDev", at: "2026-08-29 10:00:00" });
		}
		await expect(
			registerAccount(env, owner, { email: "x@y.ro", token: "003|t", cif: "RO1" }),
		).rejects.toThrow(/Too many register_account attempts/);
	});
});

describe("proforma / stocks / restore-delete", () => {
	beforeEach(() => stubSmartBill());
	afterEach(() => vi.unstubAllGlobals());

	it("create_proforma creates a quote with smart defaults (proforma series)", async () => {
		const { env } = makeEnv();
		const res = await createEstimate(env, owner, {
			client: { name: "ACME", country: "Romania" },
			products: [{ name: "Service", quantity: 1, unitPrice: 100 }],
		});
		expect(res.content[0].text).toContain("Proforma created");
		expect(res.content[0].text).toContain("SRP");
		expect(res.content[0].text).toContain("invoice it");
	});

	it("estimate_invoices reports whether the proforma was invoiced", async () => {
		const { env } = makeEnv();
		const res = await estimateInvoices(env, owner, { series: "SRP", number: "5" });
		expect(res.content[0].text).toContain("Yes");
		expect(res.content[0].text).toContain("SR/77");
	});

	it("proforma_pdf returns base64 PDF", async () => {
		const { env } = makeEnv();
		const res = await estimatePdf(env, owner, { series: "SRP", number: "5" });
		expect(res.content[0].text).toContain("Proforma PDF");
	});

	it("cancel_proforma requires confirm:true", async () => {
		const { env } = makeEnv();
		await expect(estimateCancel(env, owner, { series: "SRP", number: "5" })).rejects.toThrow(/confirm/);
		const ok = await estimateCancel(env, owner, { series: "SRP", number: "5", confirm: true });
		expect(ok.content[0].text).toContain("cancelled");
	});

	it("restore_proforma restores a cancelled quote", async () => {
		const { env } = makeEnv();
		const res = await estimateRestore(env, owner, { series: "SRP", number: "5" });
		expect(res.content[0].text).toContain("restored");
	});

	it("invoiceDelete requires confirm and flags the ledger row cancelled", async () => {
		const { env, db } = makeEnv();
		await seedDraft(env, db);
		await expect(invoiceDelete(env, owner, { series: "SR", number: "1" })).rejects.toThrow(/confirm/);
		const res = await invoiceDelete(env, owner, { series: "SR", number: "1", confirm: true });
		expect(res.content[0].text).toContain("deleted");
	});

	it("list_stocks returns stock items", async () => {
		const { env } = makeEnv();
		const res = await stocks(env, owner, { date: "2026-08-29" });
		expect(res.content[0].text).toContain("Widget");
		expect(res.content[0].text).toContain("12");
	});

	it("paymentDelete requires confirm", async () => {
		const { env } = makeEnv();
		await expect(paymentDelete(env, owner, { paymentType: "Card" })).rejects.toThrow(/confirm/);
		const res = await paymentDelete(env, owner, { paymentType: "CEC", invoiceSeries: "SR", invoiceNumber: "1", confirm: true });
		expect(res.content[0].text).toContain("deleted");
	});

	it("convert_proforma requires confirm and converts a proforma into an invoice via estimate", async () => {
		const { env, db } = makeEnv();
		await expect(convertProforma(env, owner, { series: "SRP", number: "1" })).rejects.toThrow(/confirm/);
		const res = await convertProforma(env, owner, { series: "SRP", number: "1", confirm: true });
		expect(res.content[0].text).toContain("converted to invoice");
		expect(res.content[0].text).toContain("SR/");
		expect(db.invoices.some((r) => r.status === "issued")).toBe(true);
	});
});
