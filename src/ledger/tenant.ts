import type { AuthUser, Env } from "../env";
import { decryptToken, encryptToken } from "./crypto";

export interface TenantRow {
	id: string;
	user_id: string;
	smartbill_email: string;
	token_enc: string;
	token_iv: string;
	cif: string;
	cif_fallback: string | null;
}

export interface TenantCreds {
	email: string;
	token: string;
	cif: string;
	cifFallback?: string;
}

export class TenantNotFoundError extends Error {
	constructor(userId: string) {
		super(`No SmartBill tenant bound to "${userId}" — use register_account to bind your own credentials`);
		this.name = "TenantNotFoundError";
	}
}

export class TenantExistsError extends Error {
	constructor(userId: string) {
		super(`A tenant already exists for "${userId}" — provide overwrite confirmation to replace credentials`);
		this.name = "TenantExistsError";
	}
}

/** Build the tenants id (uuid-ish) if absent. */
function newId(): string {
	return crypto.randomUUID();
}

export async function getTenantRow(db: D1Database, userId: string): Promise<TenantRow | null> {
	const res = await db.prepare("SELECT * FROM tenants WHERE user_id = ?").bind(userId).first<TenantRow>();
	return res ?? null;
}

/**
 * Ensure a tenants row exists for the (owner) user, seeding from SMARTBILL_* env on first run.
 * SINGLE SOURCE OF TRUTH = D1 tenants.token_enc; env SMARTBILL_TOKEN is a bootstrap seed only.
 * Non-owner users get no auto-seed (they must register_account).
 */
export async function ensureTenant(env: Env, authUser: AuthUser): Promise<TenantRow> {
	const existing = await getTenantRow(env.DB, authUser.login);
	if (existing) return existing;

	const isOwner = authUser.login === env.OWNER_GITHUB_LOGIN;
	if (!isOwner) {
		// No seed for non-owners; register_account path.
		throw new TenantNotFoundError(authUser.login);
	}

	const cipher = await encryptToken(env.SMARTBILL_TOKEN, env.ENCRYPTION_KEY);
	const id = newId();
	await env.DB.prepare(
		`INSERT INTO tenants (id, user_id, smartbill_email, token_enc, token_iv, cif, cif_fallback)
		 VALUES (?, ?, ?, ?, ?, ?, ?)`,
	)
		.bind(id, authUser.login, env.SMARTBILL_EMAIL, cipher.enc, cipher.iv, env.SMARTBILL_CIF, env.SMARTBILL_CIF_FALLBACK ?? null)
		.run();
	return { id, user_id: authUser.login, smartbill_email: env.SMARTBILL_EMAIL, token_enc: cipher.enc, token_iv: cipher.iv, cif: env.SMARTBILL_CIF, cif_fallback: env.SMARTBILL_CIF_FALLBACK ?? null };
}

/**
 * Resolve the authenticated user's tenant and decrypt their SmartBill credentials.
 * Rejects non-invited users (allowlist) and unfound tenants.
 */
export async function getTenantForAuthUser(env: Env, authUser: AuthUser): Promise<TenantCreds> {
	const row = await getTenantRow(env.DB, authUser.login);
	if (!row) throw new TenantNotFoundError(authUser.login);
	const token = await decryptToken({ enc: row.token_enc, iv: row.token_iv }, env.ENCRYPTION_KEY);
	return {
		email: row.smartbill_email,
		token,
		cif: row.cif,
		cifFallback: row.cif_fallback ?? undefined,
	};
}

/** Update a tenant's encrypted token (used for SmartBill token rotation — SAME KEY, never re-key). */
export async function updateTenantToken(env: Env, userId: string, newToken: string): Promise<void> {
	const cipher = await encryptToken(newToken, env.ENCRYPTION_KEY);
	await env.DB.prepare("UPDATE tenants SET token_enc = ?, token_iv = ? WHERE user_id = ?")
		.bind(cipher.enc, cipher.iv, userId)
		.run();
}

/** Register (or overwrite) a tenant's own SmartBill credentials for the authenticating user. */
export async function registerTenant(env: Env, authUser: AuthUser, opts: { email: string; token: string; cif: string; cifFallback?: string }, overwrite = false): Promise<void> {
	const existing = await getTenantRow(env.DB, authUser.login);
	if (existing && !overwrite) throw new TenantExistsError(authUser.login);
	const cipher = await encryptToken(opts.token, env.ENCRYPTION_KEY);
	if (existing) {
		await env.DB.prepare("UPDATE tenants SET smartbill_email = ?, token_enc = ?, token_iv = ?, cif = ?, cif_fallback = ? WHERE user_id = ?")
			.bind(opts.email, cipher.enc, cipher.iv, opts.cif, opts.cifFallback ?? null, authUser.login)
			.run();
	} else {
		await env.DB.prepare("INSERT INTO tenants (id, user_id, smartbill_email, token_enc, token_iv, cif, cif_fallback) VALUES (?, ?, ?, ?, ?, ?, ?)")
			.bind(newId(), authUser.login, opts.email, cipher.enc, cipher.iv, opts.cif, opts.cifFallback ?? null)
			.run();
	}
}
