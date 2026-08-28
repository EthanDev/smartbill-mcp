import { describe, expect, it, vi } from "vitest";
import type { AuthRequest, ClientInfo } from "@cloudflare/workers-oauth-provider";
import { GitHubHandler } from "../../src/auth/github-handler";
import { generateCSRFProtection } from "../../src/auth/oauth-utils";
import { fetchGitHubUser, fetchUpstreamAuthToken } from "../../src/auth/utils";
import type { Env } from "../../src/env";

// Mock upstream GitHub IO only — keep getUpstreamAuthorizeUrl/Props real.
vi.mock("../../src/auth/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/auth/utils")>();
	return {
		...actual,
		fetchUpstreamAuthToken: vi.fn(),
		fetchGitHubUser: vi.fn(),
	};
});

const COOKIE_SECRET = "c".repeat(64);

/** SHA-256 hex, matching the __Host-CONSENTED_STATE binding in oauth-utils. */
async function sha256Hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** In-memory KVNamespace used by the OAuth state store. */
function makeKV(): KVNamespace & { store: Map<string, string> } {
	const store = new Map<string, string>();
	return {
		store,
		async get(key: string) {
			return store.get(key) ?? null;
		},
		async put(key: string, value: string) {
			store.set(key, value);
		},
		async delete(key: string) {
			store.delete(key);
		},
	} as unknown as KVNamespace & { store: Map<string, string> };
}

function makeOAuthHelpers() {
	return {
		parseAuthRequest: vi.fn(),
		lookupClient: vi.fn(),
		completeAuthorization: vi.fn(),
	};
}

type Helpers = ReturnType<typeof makeOAuthHelpers>;

type MockEnv = Env & { OAUTH_PROVIDER: unknown };

function makeEnv(helpers: Helpers, overrides: Partial<MockEnv> = {}): MockEnv {
	return {
		OAUTH_KV: makeKV(),
		DB: {} as D1Database,
		SMARTBILL_EMAIL: "a@b.ro",
		SMARTBILL_TOKEN: "t",
		SMARTBILL_CIF: "RO47247261",
		GITHUB_CLIENT_ID: "test-client",
		GITHUB_CLIENT_SECRET: "test-secret",
		COOKIE_ENCRYPTION_KEY: COOKIE_SECRET,
		ENCRYPTION_KEY: "e".repeat(64),
		OWNER_GITHUB_LOGIN: "EthanDev",
		ALLOWED_GITHUB_LOGINS: "EthanDev",
		OAUTH_PROVIDER: helpers,
		...overrides,
	};
}

const AUTH_REQ: AuthRequest = {
	responseType: "code",
	clientId: "test-client",
	redirectUri: "http://localhost:8788/callback",
	scope: ["read:user"],
	state: "client-state",
};

async function seedState(kv: KVNamespace, authReq: AuthRequest): Promise<string> {
	const stateToken = crypto.randomUUID();
	await kv.put(`oauth:state:${stateToken}`, JSON.stringify(authReq), { expirationTtl: 600 });
	return stateToken;
}

/** A Set-Cookie header value -> the bare cookie pair for a request Cookie header. */
function cookiePair(setCookie: string): string {
	return setCookie.split(";")[0];
}

describe("GET /authorize — parse + consent dialog", () => {
	it("renders the approval dialog and sets the __Host-CSRF_TOKEN cookie when the client is not yet approved", async () => {
		const helpers = makeOAuthHelpers();
		const env = makeEnv(helpers);
		vi.mocked(helpers.parseAuthRequest).mockResolvedValue(AUTH_REQ);
		vi.mocked(helpers.lookupClient).mockResolvedValue({
			clientId: "test-client",
			clientName: "MCP Inspector",
			redirectUris: ["http://localhost:8788/callback"],
		} as ClientInfo);

		const res = await GitHubHandler.request("/authorize", { method: "GET" }, env);

		expect(res.status).toBe(200);
		const setCookie = res.headers.get("Set-Cookie") ?? "";
		expect(setCookie).toContain("__Host-CSRF_TOKEN=");
		expect(setCookie).toContain("Secure");

		const body = await res.text();
		expect(body).toContain("MCP Inspector");
		expect(body).toContain("Approve");
	});
});

describe("POST /authorize — consent CSRF", () => {
	it("redirects to GitHub with a bound state cookie after a valid CSRF token", async () => {
		const helpers = makeOAuthHelpers();
		const env = makeEnv(helpers);
		const { token: csrfToken, setCookie } = generateCSRFProtection();
		const form = new FormData();
		form.set("csrf_token", csrfToken);
		form.set("state", btoa(JSON.stringify({ oauthReqInfo: AUTH_REQ })));

		const res = await GitHubHandler.request(
			"/authorize",
			{ method: "POST", headers: { Cookie: cookiePair(setCookie) }, body: form },
			env,
		);

		expect(res.status).toBe(302);
		const location = res.headers.get("Location") ?? "";
		expect(location).toContain("https://github.com/login/oauth/authorize");
		expect(location).toContain("client_id=test-client");
		expect(location).toContain("state=");

		const setCookies = res.headers.getSetCookie();
		const flat = setCookies.join("; ");
		expect(flat).toContain("__Host-APPROVED_CLIENTS=");
		expect(flat).toContain("__Host-CONSENTED_STATE=");
	});

	it("rejects a mismatched CSRF token with 400 invalid_request", async () => {
		const helpers = makeOAuthHelpers();
		const env = makeEnv(helpers);
		const { token: csrfToken } = generateCSRFProtection();
		const form = new FormData();
		form.set("csrf_token", csrfToken);
		form.set("state", btoa(JSON.stringify({ oauthReqInfo: AUTH_REQ })));

		const res = await GitHubHandler.request(
			"/authorize",
			{ method: "POST", headers: { Cookie: "__Host-CSRF_TOKEN=WRONG" }, body: form },
			env,
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid_request");
	});

	it("rejects a missing CSRF token with 400 invalid_request", async () => {
		const helpers = makeOAuthHelpers();
		const env = makeEnv(helpers);
		const form = new FormData();
		form.set("state", btoa(JSON.stringify({ oauthReqInfo: AUTH_REQ })));

		const res = await GitHubHandler.request("/authorize", { method: "POST", body: form }, env);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid_request");
	});
});

describe("GET /callback — allowlist enforcement", () => {
	it("rejects a GitHub user not on the allowlist with 403 and never completes authorization", async () => {
		const helpers = makeOAuthHelpers();
		const env = makeEnv(helpers);
		const stateToken = await seedState(env.OAUTH_KV, AUTH_REQ);
		const consentCookie = await sha256Hex(stateToken);

		vi.mocked(fetchUpstreamAuthToken).mockResolvedValue(["gh-token", null]);
		vi.mocked(fetchGitHubUser).mockResolvedValue({ login: "mallory", name: "Mallory", email: "m@x.ro" });

		const res = await GitHubHandler.request(
			`/callback?state=${stateToken}&code=abc`,
			{ method: "GET", headers: { Cookie: `__Host-CONSENTED_STATE=${consentCookie}` } },
			env,
		);

		expect(res.status).toBe(403);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("access_denied");
		expect(helpers.completeAuthorization).not.toHaveBeenCalled();
	});

	it("completes authorization and redirects for an allowlisted user", async () => {
		const helpers = makeOAuthHelpers();
		const env = makeEnv(helpers);
		const stateToken = await seedState(env.OAUTH_KV, AUTH_REQ);
		const consentCookie = await sha256Hex(stateToken);

		vi.mocked(fetchUpstreamAuthToken).mockResolvedValue(["gh-token", null]);
		vi.mocked(fetchGitHubUser).mockResolvedValue({ login: "EthanDev", name: "Ethan", email: "e@b.ro" });
		vi.mocked(helpers.completeAuthorization).mockResolvedValue({ redirectTo: "https://client.example/cb?ok=1" });

		const res = await GitHubHandler.request(
			`/callback?state=${stateToken}&code=abc`,
			{ method: "GET", headers: { Cookie: `__Host-CONSENTED_STATE=${consentCookie}` } },
			env,
		);

		expect(res.status).toBe(302);
		expect(res.headers.get("Location")).toBe("https://client.example/cb?ok=1");
		expect(helpers.completeAuthorization).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "EthanDev",
				props: expect.objectContaining({ login: "EthanDev" }),
			}),
		);
	});

	it("returns 400 when the state does not match the bound session cookie", async () => {
		const helpers = makeOAuthHelpers();
		const env = makeEnv(helpers);
		const stateToken = await seedState(env.OAUTH_KV, AUTH_REQ);
		const otherConsentCookie = await sha256Hex(crypto.randomUUID());

		const res = await GitHubHandler.request(
			`/callback?state=${stateToken}&code=abc`,
			{ method: "GET", headers: { Cookie: `__Host-CONSENTED_STATE=${otherConsentCookie}` } },
			env,
		);

		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toBe("invalid_request");
	});
});
