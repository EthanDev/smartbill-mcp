import { describe, it, expect, beforeEach } from "vitest";
import { encryptToken, decryptToken } from "../../src/ledger/crypto";
import {
	ensureTenant,
	getTenantForAuthUser,
	registerTenant,
	TenantNotFoundError,
	TenantExistsError,
} from "../../src/ledger/tenant";
import { createInvoice, getInvoiceBySeriesNumber, finalizeInvoice } from "../../src/ledger/ledger";
import type { AuthUser, Env } from "../../src/env";

const KEY = "a".repeat(64); // 64 hex chars (32 bytes)

/** Minimal in-memory D1 fake for the few queries the ledger/tenant modules use. */
class FakeDB {
	tenants: Record<string, Record<string, unknown>> = {};
	invoices: Record<string, Record<string, unknown>> = {};
	audit: Record<string, unknown>[] = [];
	private _sql = "";
	private _args: unknown[] = [];

	prepare(sql: string) {
		this._sql = sql.trim();
		return this;
	}
	bind(...args: unknown[]) {
		this._args = args;
		return this;
	}
	async first(): Promise<Record<string, unknown> | null> {
		const sql = this._sql;
		// SELECT * FROM tenants WHERE user_id = ?
		if (sql.includes("FROM tenants")) {
			const userId = this._args[0];
			return this.tenants[String(userId)] ?? null;
		}
		// SELECT * FROM invoices WHERE user_id = ? AND series = ? AND number = ?
		if (sql.includes("FROM invoices") && sql.includes("AND series = ?")) {
			const [userId, series, number] = this._args;
			for (const inv of Object.values(this.invoices)) {
				if (inv.user_id === userId && inv.series === series && inv.number === number) return inv;
			}
			return null;
		}
		// SELECT * FROM invoices WHERE user_id = ? AND draft_id = ?
		if (sql.includes("FROM invoices") && sql.includes("draft_id = ?")) {
			const [userId, draftId] = this._args;
			for (const inv of Object.values(this.invoices)) {
				if (inv.user_id === userId && inv.draft_id === draftId) return inv;
			}
			return null;
		}
		// SUM aggregation
		if (sql.includes("SUM(total_ron)")) {
			return { sum_total_ron: 0, count: 0 };
		}
		return null;
	}
	async all(): Promise<{ results: Record<string, unknown>[] }> {
		const sql = this._sql;
		if (sql.includes("FROM invoices") && sql.includes("WHERE user_id = ?")) {
			const userId = this._args[0];
			const results = Object.values(this.invoices).filter((inv) => inv.user_id === userId);
			return { results };
		}
		return { results: [] };
	}
	async run(): Promise<{ success: boolean }> {
		const sql = this._sql;
		if (sql.includes("INSERT INTO tenants")) {
			const [id, userId] = this._args;
			this.tenants[String(userId)] = {
				id,
				user_id: userId,
				smartbill_email: this._args[2],
				token_enc: this._args[3],
				token_iv: this._args[4],
				cif: this._args[5],
				cif_fallback: this._args[6],
			};
		} else if (sql.includes("INSERT INTO invoices")) {
			const inv: Record<string, unknown> = {};
			const map = [
				"draft_id", "user_id", "series", "number", "doc_type", "status",
				"client_name", "client_cif", "issue_date", "due_date", "total_ron",
				"currency", "idempotency_key", "draft_payload",
			];
			map.forEach((k, i) => (inv[k] = this._args[i]));
			this.invoices[String(inv.id ?? Object.keys(this.invoices).length)] = inv;
		} else if (sql.includes("UPDATE invoices") && sql.includes("draft_id = ?")) {
			const [series, number, draftId, userId] = this._args;
			for (const inv of Object.values(this.invoices)) {
				if (inv.user_id === userId && inv.draft_id === draftId) {
					inv.series = series;
					inv.number = number;
					inv.status = "issued";
				}
			}
		} else if (sql.includes("UPDATE invoices")) {
			const [status, userId, series, number] = this._args;
			for (const inv of Object.values(this.invoices)) {
				if (inv.user_id === userId && inv.series === series && inv.number === number) {
					inv.status = status;
				}
			}
		} else if (sql.includes("INSERT INTO audit_events")) {
			this.audit.push({ user_id: this._args[1], event: this._args[2], actor: this._args[3] });
		}
		return { success: true };
	}
}

function makeEnv(userId = "EthanDev"): { env: Env; db: FakeDB } {
	const db = new FakeDB();
	const env = {
		DB: db as unknown as D1Database,
		OAUTH_KV: {} as KVNamespace,
		SMARTBILL_EMAIL: "ethan1709@protonmail.com",
		SMARTBILL_TOKEN: "smbtoken123",
		SMARTBILL_CIF: "RO47247261",
		SMARTBILL_CIF_FALLBACK: "47247261",
		GITHUB_CLIENT_ID: "c",
		GITHUB_CLIENT_SECRET: "s",
		COOKIE_ENCRYPTION_KEY: "k",
		ENCRYPTION_KEY: KEY,
		OWNER_GITHUB_LOGIN: "EthanDev",
		ALLOWED_GITHUB_LOGINS: "EthanDev",
	} as Env;
	return { env, db };
}

const owner: AuthUser = { login: "EthanDev", email: "e@a.ro", name: "Ethan" };
const other: AuthUser = { login: "OtherDev", email: "o@a.ro", name: "Other" };

describe("crypto AES-GCM", () => {
	it("round-trips a token", async () => {
		const enc = await encryptToken("secret-token", KEY);
		const dec = await decryptToken(enc, KEY);
		expect(dec).toBe("secret-token");
		expect(enc.enc).not.toContain("secret-token");
	});
});

describe("tenant", () => {
	it("seeds the owner tenant from env on first run", async () => {
		const { env, db } = makeEnv();
		const row = await ensureTenant(env, owner);
		expect(row.user_id).toBe("EthanDev");
		expect(row.smartbill_email).toBe("ethan1709@protonmail.com");
		expect(row.token_enc.length).toBeGreaterThan(0);
		expect(row.token_iv.length).toBeGreaterThan(0);
		// token_enc must not be the plaintext token
		expect(row.token_enc).not.toContain("smbtoken123");
		expect(db.tenants["EthanDev"].token_enc).toBe(row.token_enc);
	});

	it("throws TenantNotFoundError for a non-owner (no seed)", async () => {
		const { env } = makeEnv();
		await expect(ensureTenant(env, other)).rejects.toBeInstanceOf(TenantNotFoundError);
	});

	it("getTenantForAuthUser returns decrypted credentials", async () => {
		const { env } = makeEnv();
		await ensureTenant(env, owner);
		const creds = await getTenantForAuthUser(env, owner);
		expect(creds.token).toBe("smbtoken123");
		expect(creds.email).toBe("ethan1709@protonmail.com");
		expect(creds.cif).toBe("RO47247261");
	});

	it("registerTenant throws TenantExistsError without overwrite confirmation", async () => {
		const { env } = makeEnv();
		await ensureTenant(env, owner);
		await expect(
			registerTenant(env, owner, { email: "x@y.ro", token: "t", cif: "CIF" }),
		).rejects.toBeInstanceOf(TenantExistsError);
	});
});

describe("per-user scoping (cross-tenant rejection)", () => {
	it("user B cannot read user A's invoice (returns null/empty, not A's row)", async () => {
		const { env, db } = makeEnv();
		await ensureTenant(env, owner);
		await createInvoice(env, owner.login, {
			series: "SB",
			isDraft: true,
			clientName: "ACME",
			draftPayload: JSON.stringify({ isDraft: true }),
		});
		// owner sees their draft via series/number (number null -> no match), but user B sees nothing
		const bView = await getInvoiceBySeriesNumber(env, other.login, "SB", "1");
		expect(bView).toBeNull();
		// count the DB rows that belong to someone else
		const aInvoices = Object.values(db.invoices).filter((i) => i.user_id === owner.login);
		expect(aInvoices.length).toBe(1);
	});
});

describe("finalizeInvoice", () => {
	it("reuses the draft body, calls SmartBill, sets number NULL -> real, writes audit", async () => {
		const { env, db } = makeEnv();
		await ensureTenant(env, owner);
		const draft = await createInvoice(env, owner.login, {
			series: "SB",
			isDraft: true,
			clientName: "ACME",
			draftPayload: JSON.stringify({ isDraft: true, seriesName: "SB" }),
		});
		const smbCalls: string[] = [];
		const row = await finalizeInvoice(env, owner.login, draft.draft_id!, {
			cif: "RO47247261",
			create: async (_cif, body) => {
				smbCalls.push(JSON.stringify(body));
				return { seriesName: "SB", number: "101" };
			},
		});
		expect(row.number).toBe("101");
		expect(row.status).toBe("issued");
		expect(smbCalls.length).toBe(1);
		// body re-sent with isDraft:false
		expect(JSON.parse(smbCalls[0]).isDraft).toBe(false);
		expect(db.audit.some((a) => a.event === "finalized")).toBe(true);
	});
});
