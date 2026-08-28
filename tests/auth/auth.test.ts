import { describe, expect, it } from "vitest";
import type { Env } from "../../src/env";
import { getAuthUser, isAllowedLogin, NotInvitedError, parseAllowedLogins } from "../../src/auth/auth";

/** Minimal Env for pure allowlist logic. None of the bindings are used here. */
function makeEnv(overrides: Partial<Env> = {}): Env {
	return {
		OAUTH_KV: {} as KVNamespace,
		DB: {} as D1Database,
		SMARTBILL_EMAIL: "a@b.ro",
		SMARTBILL_TOKEN: "t",
		SMARTBILL_CIF: "RO47247261",
		GITHUB_CLIENT_ID: "c",
		GITHUB_CLIENT_SECRET: "s",
		COOKIE_ENCRYPTION_KEY: "k",
		ENCRYPTION_KEY: "e",
		OWNER_GITHUB_LOGIN: "EthanDev",
		ALLOWED_GITHUB_LOGINS: "EthanDev, alice ,BOB",
		OAUTH_PROVIDER: undefined,
		...overrides,
	};
}

describe("parseAllowedLogins", () => {
	it("always includes the owner login, lowercased", () => {
		const allowed = parseAllowedLogins(makeEnv({ ALLOWED_GITHUB_LOGINS: "" }));
		expect(allowed.has("ethandev")).toBe(true);
	});

	it("parses comma-separated logins, trims and lowercases", () => {
		const allowed = parseAllowedLogins(makeEnv());
		expect([...allowed].sort()).toEqual(["alice", "bob", "ethandev"]);
	});

	it("ignores empty/whitespace entries", () => {
		const allowed = parseAllowedLogins(makeEnv({ ALLOWED_GITHUB_LOGINS: "x,, y," }));
		expect([...allowed].sort()).toEqual(["ethandev", "x", "y"]);
	});
});

describe("isAllowedLogin", () => {
	it("accepts the owner and listed logins case-insensitively", () => {
		const env = makeEnv();
		expect(isAllowedLogin(env, "EthanDev")).toBe(true);
		expect(isAllowedLogin(env, "alice")).toBe(true);
		expect(isAllowedLogin(env, "BOB")).toBe(true);
	});

	it("rejects unknown logins and empty/undefined values", () => {
		const env = makeEnv();
		expect(isAllowedLogin(env, "mallory")).toBe(false);
		expect(isAllowedLogin(env, undefined)).toBe(false);
		expect(isAllowedLogin(env, "")).toBe(false);
		expect(isAllowedLogin(env, null)).toBe(false);
	});
});

describe("getAuthUser", () => {
	it("returns an AuthUser for an allowlisted login", () => {
		const user = getAuthUser({ login: "ethandev", email: "e@b.ro", name: "Ethan" }, makeEnv());
		expect(user).toEqual({ login: "ethandev", email: "e@b.ro", name: "Ethan" });
	});

	it("throws NotInvitedError for a login not on the allowlist", () => {
		expect(() => getAuthUser({ login: "mallory" }, makeEnv())).toThrow(NotInvitedError);
	});

	it("throws when there is no login in the auth context", () => {
		expect(() => getAuthUser(undefined, makeEnv())).toThrow(/Unauthenticated/);
		expect(() => getAuthUser({}, makeEnv())).toThrow(/Unauthenticated/);
	});
});
