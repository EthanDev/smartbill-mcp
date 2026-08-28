import OAuthProvider from "@cloudflare/workers-oauth-provider";
import { McpServer } from "@modelcontextprotocol/server";
import { createMcpHandler } from "agents/mcp/server";
import { GitHubHandler } from "./auth/github-handler";
import type { Env } from "./env";
import { registerTools } from "./tools";

/**
 * Builds the MCP server for a single request. This is the stateless factory used
 * by `createMcpHandler` — it returns a fresh McpServer per request with the tools
 * registered. `getMcpAuthContext()` (from agents/mcp/server) provides the
 * authenticated user props (login/email/name) inside each tool handler.
 */
function createServer() {
	const server = new McpServer({
		name: "smartbill",
		version: "0.1.0",
	});
	registerTools(server);
	return server;
}

// Stateless MCP handler (agents SDK). Returns a callable that is ALSO an object
// with `.fetch`/`.notify`, so we wrap it in a plain object for OAuthProvider's
// `validateHandler` (which requires typeof === "object").
const statelessMcp = createMcpHandler(createServer, { route: "/mcp" });

const mcpApiHandler = {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		return statelessMcp(request, env, ctx);
	},
};

const oauth = new OAuthProvider({
	apiRoute: "/mcp",
	apiHandler: mcpApiHandler,
	defaultHandler: GitHubHandler,
	authorizeEndpoint: "/authorize",
	tokenEndpoint: "/token",
	clientRegistrationEndpoint: "/register",
});

export default {
	async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === "/health") {
			return new Response(JSON.stringify({ status: "ok" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}
		return oauth.fetch(request, env, ctx);
	},
} satisfies ExportedHandler<Env>;
