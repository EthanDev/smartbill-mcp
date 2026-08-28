import { env } from "cloudflare:workers";
import { getMcpAuthContext } from "agents/mcp/server";
import type { McpServer } from "@modelcontextprotocol/server";
import type { Env } from "../env";
import * as schemas from "./schemas";
import * as logic from "./logic";

type Props = { login?: string; email?: string; name?: string };

function props(): Props | undefined {
	const ctx = getMcpAuthContext();
	return ctx?.props as Props | undefined;
}

/** The request env, via cloudflare:workers. */
const envAny = env as unknown as Env;

/**
 * Registers all smartbill MCP tools on the server.
 * Handlers resolve the authenticated user from the OAuth token props (via
 * getMcpAuthContext) and the request env (via cloudflare:workers).
 */
export function registerTools(server: McpServer): void {
	server.registerTool("create_draft", {
		title: "Create SmartBill invoice draft",
		description: "Create a SmartBill draft invoice. Uses smart defaults (series, 21% VAT, RON, today). idempotency_key dedupes.",
		inputSchema: schemas.createDraftSchema,
	}, async (args) => logic.createDraft(envAny, props(), args));

	server.registerTool("finalize_invoice", {
		title: "Finalize a draft (confirm)",
		description: "Confirm + finalize a draft into an issued invoice. Must pass confirm:true.",
		inputSchema: schemas.finalizeInvoiceSchema,
	}, async (args) => logic.finalize(envAny, props(), args));

	server.registerTool("send_invoice", {
		title: "Email an invoice (confirm)",
		description: "Send an issued invoice by email. Must pass confirm:true.",
		inputSchema: schemas.sendInvoiceSchema,
	}, async (args) => logic.sendInvoice(envAny, props(), args));

	server.registerTool("record_payment", {
		title: "Record an invoice payment (confirm)",
		description: "Record a payment against an invoice. Must pass confirm:true.",
		inputSchema: schemas.recordPaymentSchema,
	}, async (args) => logic.recordPayment(envAny, props(), args));

	server.registerTool("cancel_invoice", {
		title: "Cancel an invoice (confirm)",
		description: "Cancel an invoice. Must pass confirm:true.",
		inputSchema: schemas.cancelInvoiceSchema,
	}, async (args) => logic.cancel(envAny, props(), args));

	server.registerTool("storno", {
		title: "Storno an invoice (confirm)",
		description: "Reverse (storno) an invoice. Must pass confirm:true.",
		inputSchema: schemas.stornoSchema,
	}, async (args) => logic.storno(envAny, props(), args));

	server.registerTool("invoice_status", {
		title: "Invoice status",
		description: "Ledger status + live SmartBill payment status for an invoice.",
		inputSchema: schemas.invoiceStatusSchema,
	}, async (args) => logic.invoiceStatus(envAny, props(), args));

	server.registerTool("get_pdf", {
		title: "Get invoice PDF",
		description: "Fetch the invoice PDF (base64). Size-bounded.",
		inputSchema: schemas.getPdfSchema,
	}, async (args) => logic.pdf(envAny, props(), args));

	server.registerTool("list_series", {
		title: "List invoice series",
		description: "List SmartBill document series (V1 read).",
		inputSchema: schemas.listSeriesSchema,
	}, async (args) => logic.series(envAny, props(), args));

	server.registerTool("list_tax", {
		title: "List tax rates",
		description: "List configured SmartBill tax rates (V1 read).",
		inputSchema: schemas.listTaxSchema,
	}, async (_args) => logic.tax(envAny, props()));

	server.registerTool("list_clients", {
		title: "List clients",
		description: "List clients (V3 read). Returns 'V3 not configured' if no V3 token.",
		inputSchema: schemas.listClientsSchema,
	}, async (args) => logic.clients(envAny, props(), args));

	server.registerTool("list_products", {
		title: "List products",
		description: "List products (V3 read). Returns 'V3 not configured' if no V3 token.",
		inputSchema: schemas.listProductsSchema,
	}, async (args) => logic.products(envAny, props(), args));

	server.registerTool("search_invoices", {
		title: "Search invoices",
		description: "Search the D1 ledger for this user's invoices (client/status/date/text).",
		inputSchema: schemas.searchInvoicesSchema,
	}, async (args) => logic.search(envAny, props(), args));

	server.registerTool("count_totals", {
		title: "Sum totals",
		description: "Count + sum total RON for a month/client/status (confirm-free).",
		inputSchema: schemas.countTotalsSchema,
	}, async (args) => logic.totals(envAny, props(), args));

	server.registerTool("register_account", {
		title: "Register SmartBill account",
		description: "Bind the caller's own SmartBill creds (encrypted at rest). Probes creds first; throttled to 5/hour.",
		inputSchema: schemas.registerAccountSchema,
	}, async (args) => logic.registerAccount(envAny, props(), args));
}
