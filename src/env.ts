/**
 * Env bindings + secrets for smartbill-mcp.
 * Bindings (OAUTH_KV, DB) are declared in wrangler.jsonc; the rest are secrets/vars
 * provided via `wrangler secret put` (prod) or `.dev.vars` (local). OAUTH_PROVIDER is
 * injected by `@cloudflare/workers-oauth-provider` at request time — do NOT declare it
 * in wrangler.jsonc or set it as a secret.
 */
export interface Env {
	// --- bindings ---
	OAUTH_KV: KVNamespace;
	DB: D1Database;

	// --- SmartBill owner bootstrap (SINGLE SOURCE OF TRUTH is D1 tenants.token_enc) ---
	SMARTBILL_EMAIL: string;
	SMARTBILL_TOKEN: string;
	SMARTBILL_CIF: string;
	SMARTBILL_CIF_FALLBACK?: string;

	// --- GitHub OAuth ---
	GITHUB_CLIENT_ID: string;
	GITHUB_CLIENT_SECRET: string;
	COOKIE_ENCRYPTION_KEY: string;

	// --- ledger token encryption (AES-GCM, current production key, never re-keyed) ---
	ENCRYPTION_KEY: string;

	// --- owner / allowlist ---
	OWNER_GITHUB_LOGIN: string;
	ALLOWED_GITHUB_LOGINS: string;
	/** true = any authenticated GitHub user may use the MCP (then bind their own SmartBill account); false = invite-only */
	OPEN_REGISTRATION?: string;

	// --- injected by OAuthProvider at runtime ---
	OAUTH_PROVIDER?: unknown;
}

/** A user bound to a SmartBill tenant. */
export interface AuthUser {
	login: string;
	email?: string;
	name?: string;
}
