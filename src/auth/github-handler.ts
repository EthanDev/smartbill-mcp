import type { AuthRequest, OAuthHelpers } from "@cloudflare/workers-oauth-provider";
import { Hono } from "hono";
import type { Env } from "../env";
import { isAllowedLogin } from "./auth";
import {
	addApprovedClient,
	bindStateToSession,
	createOAuthState,
	generateCSRFProtection,
	isClientApproved,
	OAuthError,
	renderApprovalDialog,
	validateCSRFToken,
	validateOAuthState,
} from "./oauth-utils";
import { fetchGitHubUser, fetchUpstreamAuthToken, getUpstreamAuthorizeUrl, type Props } from "./utils";

type HandlerEnv = Env & { OAUTH_PROVIDER: OAuthHelpers };

const app = new Hono<{ Bindings: HandlerEnv }>();

function redirectToGithub(
	request: Request,
	clientId: string,
	stateToken: string,
	setCookies: string[] = [],
) {
	const headers = new Headers({
		location: getUpstreamAuthorizeUrl({
			client_id: clientId,
			redirect_uri: new URL("/callback", request.url).href,
			scope: "read:user",
			state: stateToken,
			upstream_url: "https://github.com/login/oauth/authorize",
		}),
	});
	// Preserve EVERY Set-Cookie — a plain-object spread would collapse duplicate
	// Set-Cookie names and drop the __Host-APPROVED_CLIENTS consent cookie.
	for (const cookie of setCookies) headers.append("Set-Cookie", cookie);
	return new Response(null, { headers, status: 302 });
}

app.get("/authorize", async (c) => {
	const oauthReqInfo = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw);
	const { clientId } = oauthReqInfo;
	if (!clientId) {
		return c.text("Invalid request", 400);
	}

	// Skip approval dialog if already approved, but still create secure state + bind to session.
	if (await isClientApproved(c.req.raw, clientId, c.env.COOKIE_ENCRYPTION_KEY)) {
		const { stateToken } = await createOAuthState(oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);
		return redirectToGithub(c.req.raw, c.env.GITHUB_CLIENT_ID, stateToken, [sessionBindingCookie]);
	}

	// Generate CSRF protection for the approval form.
	const { token: csrfToken, setCookie } = generateCSRFProtection();

	return renderApprovalDialog(c.req.raw, {
		client: await c.env.OAUTH_PROVIDER.lookupClient(clientId),
		csrfToken,
		server: {
			description: "SmartBill.ro invoice automation over chat.",
			logo: "https://avatars.githubusercontent.com/u/314135?s=200&v=4",
			name: "SmartBill MCP Server",
		},
		setCookie,
		state: { oauthReqInfo },
	});
});

app.post("/authorize", async (c) => {
	try {
		const formData = await c.req.raw.formData();

		// Validate CSRF token.
		validateCSRFToken(formData, c.req.raw);

		const encodedState = formData.get("state");
		if (!encodedState || typeof encodedState !== "string") {
			return c.text("Missing state in form data", 400);
		}

		let state: { oauthReqInfo?: AuthRequest };
		try {
			state = JSON.parse(atob(encodedState));
		} catch {
			return c.text("Invalid state data", 400);
		}

		if (!state.oauthReqInfo || !state.oauthReqInfo.clientId) {
			return c.text("Invalid request", 400);
		}

		const approvedClientCookie = await addApprovedClient(
			c.req.raw,
			state.oauthReqInfo.clientId,
			c.env.COOKIE_ENCRYPTION_KEY,
		);

		const { stateToken } = await createOAuthState(state.oauthReqInfo, c.env.OAUTH_KV);
		const { setCookie: sessionBindingCookie } = await bindStateToSession(stateToken);

		return redirectToGithub(
			c.req.raw,
			c.env.GITHUB_CLIENT_ID,
			stateToken,
			[approvedClientCookie, sessionBindingCookie],
		);
	} catch (error: unknown) {
		console.error("POST /authorize error:", error);
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text(`Internal server error: ${error instanceof Error ? error.message : "unknown"}`, 500);
	}
});

/**
 * OAuth Callback Endpoint. Exchanges the GitHub code for a token, fetches the
 * authenticated user, enforces the allowlist, then completes authorization by
 * binding the user's login/email/name into the MCP access-token props.
 */
app.get("/callback", async (c) => {
	let oauthReqInfo: AuthRequest;
	let clearSessionCookie: string;

	try {
		const result = await validateOAuthState(c.req.raw, c.env.OAUTH_KV);
		oauthReqInfo = result.oauthReqInfo;
		clearSessionCookie = result.clearCookie;
	} catch (error: unknown) {
		if (error instanceof OAuthError) {
			return error.toResponse();
		}
		return c.text("Internal server error", 500);
	}

	if (!oauthReqInfo.clientId) {
		return c.text("Invalid OAuth request data", 400);
	}

	const [accessToken, errResponse] = await fetchUpstreamAuthToken({
		client_id: c.env.GITHUB_CLIENT_ID,
		client_secret: c.env.GITHUB_CLIENT_SECRET,
		code: c.req.query("code"),
		redirect_uri: new URL("/callback", c.req.url).href,
		upstream_url: "https://github.com/login/oauth/access_token",
	});
	if (errResponse) return errResponse;

	// Fetch the user information from GitHub.
	let user: Props;
	try {
		user = await fetchGitHubUser(accessToken);
	} catch (error) {
		console.error("GitHub user fetch failed:", error);
		return c.text("Failed to authenticate with GitHub", 500);
	}

	// ENFORCE the allowlist — reject non-invited users before issuing a token.
	if (!isAllowedLogin(c.env, user.login)) {
		return c.json(
			{
				error: "access_denied",
				error_description: `GitHub user "${user.login}" is not invited to use this MCP server`,
			},
			403,
		);
	}

	const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
		metadata: {
			label: user.name || user.login,
		},
		props: {
			login: user.login,
			email: user.email,
			name: user.name,
		} satisfies Props,
		request: oauthReqInfo,
		scope: oauthReqInfo.scope,
		userId: user.login,
	});

	const headers = new Headers({ Location: redirectTo });
	if (clearSessionCookie) {
		headers.set("Set-Cookie", clearSessionCookie);
	}

	return new Response(null, {
		status: 302,
		headers,
	});
});

export { app as GitHubHandler };
