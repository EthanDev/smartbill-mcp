import type { AuthUser, Env } from "../env";

/**
 * Parse the comma-separated ALLOWED_GITHUB_LOGINS allowlist.
 * The owner login is always included even if absent from the env var.
 * OPEN_REGISTRATION=true lets ANY authenticated GitHub user in (they still
 * must bind their own SmartBill account via register_account, which is
 * live-probed + encrypted + throttled). Default: invite-only.
 */
export function parseAllowedLogins(env: Env): Set<string> {
	const allowed = new Set<string>();
	if (env.OPEN_REGISTRATION) return allowed;
	if (env.OWNER_GITHUB_LOGIN) allowed.add(env.OWNER_GITHUB_LOGIN.trim().toLowerCase());
	if (env.ALLOWED_GITHUB_LOGINS) {
		for (const login of env.ALLOWED_GITHUB_LOGINS.split(",")) {
			const trimmed = login.trim().toLowerCase();
			if (trimmed) allowed.add(trimmed);
		}
	}
	return allowed;
}

/** Whether the given GitHub login is invited (allowlist-enforced; open mode accepts all). */
export function isAllowedLogin(env: Env, login: string | undefined | null): boolean {
	if (!login) return false;
	if (env.OPEN_REGISTRATION) return true;
	return parseAllowedLogins(env).has(login.trim().toLowerCase());
}

/** Authentication error thrown when a user is not on the allowlist. */
export class NotInvitedError extends Error {
	constructor(login: string) {
		super(`GitHub user "${login}" is not invited to use this MCP server`);
		this.name = "NotInvitedError";
	}
}

/**
 * Resolve the authenticated user from the stateless MCP auth context.
 * `props` are the values set by `completeAuthorization({ props: { login, email, name } })`
 * and surfaced via `getMcpAuthContext()`. Throws NotInvitedError for non-invited logins.
 */
export function getAuthUser(props: { login?: string; email?: string; name?: string } | undefined, env: Env): AuthUser {
	const login = props?.login;
	if (!login) throw new Error("Unauthenticated: no user identity in auth context");
	if (!isAllowedLogin(env, login)) throw new NotInvitedError(login);
	return {
		login,
		email: props?.email,
		name: props?.name,
	};
}
