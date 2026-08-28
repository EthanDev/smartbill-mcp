import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { AuthUser, Env } from "../../src/env";
import { ensureTenant } from "../../src/ledger/tenant";
import {
	finalize,
	sendInvoice,
	recordPayment,
	cancel,
	storno,
} from "../../src/tools/logic";

const KEY = "a".repeat(64);

/** Minimal FakeDB (same shape as ledger test) for tenant/invoice resolution. */
class FakeDB {
	tenants: Record<string, Record<string, unknown>> = {};
	invoices: Record<string, Record<string, unknown>> = {};
	audit: Record<string, unknown>[] = [];
	private _args: unknown[] = [];
	prepare() {
		return this;
	}
	bind(...args: unknown[]) {
		this._args = args;
		return this;
	}
	async first(): Promise<Record<string, unknown> | null> {
		const userId = this._args[0];
		// only tenants are needed for the confirm-gate tests
		return this.tenants[String(userId)] ?? null;
	}
	async all(): Promise<{ results: Record<string, unknown>[] }> {
		return { results: [] };
	}
	async run(): Promise<{ success: boolean }> {
		const [id, userId] = this._args;
		this.tenants[String(userId)] = {
			id, user_id: userId, smartbill_email: this._args[2],
			token_enc: this._args[3], token_iv: this._args[4], cif: this._args[5], cif_fallback: this._args[6],
		};
		return { success: true };
	}
}

function makeEnv(): { env: Env } {
	const db = new FakeDB();
	const env = {
		DB: db as unknown as D1Database,
		OAUTH_KV: {} as KVNamespace,
		SMARTBILL_EMAIL: "ethan1709@protonmail.com",
		SMARTBILL_TOKEN: "token123",
		SMARTBILL_CIF: "RO47247261",
		SMARTBILL_CIF_FALLBACK: "47247261",
		GITHUB_CLIENT_ID: "c",
		GITHUB_CLIENT_SECRET: "s",
		COOKIE_ENCRYPTION_KEY: "k",
		ENCRYPTION_KEY: KEY,
		OWNER_GITHUB_LOGIN: "EthanDev",
		ALLOWED_GITHUB_LOGINS: "EthanDev",
	} as Env;
	return { env };
}

const owner: AuthUser = { login: "EthanDev", email: "e@a.ro", name: "Ethan" };

describe("confirm gate (machine-side)", () => {
	beforeEach(async () => {
		const { env } = makeEnv();
		await ensureTenant(env, owner);
		// Stub fetch so the testable logic's V1Client calls succeed.
		vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: 0, message: "ok" }), { status: 200 })));
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("finalize_invoice THROWS without confirm:true", async () => {
		const { env } = makeEnv();
		await expect(finalize(env, owner, { draft_id: "d1" })).rejects.toThrow(/confirm:true required/);
		await expect(finalize(env, owner, { draft_id: "d1", confirm: false as never })).rejects.toThrow(/confirm:true required/);
	});

	it("send_invoice THROWS without confirm:true", async () => {
		const { env } = makeEnv();
		await expect(sendInvoice(env, owner, { series: "SB", number: "1" })).rejects.toThrow(/confirm:true required/);
	});

	it("record_payment THROWS without confirm:true", async () => {
		const { env } = makeEnv();
		await expect(recordPayment(env, owner, { series: "SB", number: "1", type: "Chitanta", value: 10 })).rejects.toThrow(/confirm:true required/);
	});

	it("cancel_invoice THROWS without confirm:true", async () => {
		const { env } = makeEnv();
		await expect(cancel(env, owner, { series: "SB", number: "1" })).rejects.toThrow(/confirm:true required/);
	});

	it("storno THROWS without confirm:true", async () => {
		const { env } = makeEnv();
		await expect(storno(env, owner, { series: "SB", number: "1" })).rejects.toThrow(/confirm:true required/);
	});

	it("cancel_invoice SUCCEEDS with confirm:true (gate opens, SmartBill called)", async () => {
		const { env } = makeEnv();
		await ensureTenant(env, owner);
		const res = await cancel(env, owner, { series: "SB", number: "1", confirm: true });
		expect(res.content[0].text).toContain("cancelled");
	});

	it("record_payment SUCCEEDS with confirm:true", async () => {
		const { env } = makeEnv();
		await ensureTenant(env, owner);
		const res = await recordPayment(env, owner, { series: "SB", number: "1", type: "Chitanta", value: 10, confirm: true });
		expect(res.content[0].text).toContain("Payment");
	});
});
