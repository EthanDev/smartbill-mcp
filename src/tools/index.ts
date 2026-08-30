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

	server.registerTool("sync_ledger", {
		title: "Sync external invoices into the ledger",
		description: "Upsert a batch of external invoice rows (e.g. from a Facturi emise Excel export converted to JSON) so 'how many invoices' covers the full account, not just MCP-created ones.",
		inputSchema: schemas.syncLedgerSchema,
	}, async (args) => logic.syncLedger(envAny, props(), args));

	server.registerTool("create_proforma", {
		title: "Create a proforma (quote)",
		description: "Create a SmartBill proforma/estimate (unpaid quote) with smart defaults. Say 'invoice it' later to convert it.",
		inputSchema: schemas.createEstimateSchema,
	}, async (args) => logic.createEstimate(envAny, props(), args));

	server.registerTool("estimate_invoices", {
		title: "Check if a proforma was invoiced",
		description: "Returns whether a proforma has been converted to an invoice (and its series/number).",
		inputSchema: schemas.estimateInvoicesSchema,
	}, async (args) => logic.estimateInvoices(envAny, props(), args));

	server.registerTool("proforma_pdf", {
		title: "Get a proforma PDF",
		description: "Download a proforma PDF (base64).",
		inputSchema: schemas.estimatePdfSchema,
	}, async (args) => logic.estimatePdf(envAny, props(), args));

	server.registerTool("cancel_proforma", {
		title: "Cancel a proforma (confirm)",
		description: "Cancel a proforma. Must pass confirm:true.",
		inputSchema: schemas.estimateCancelSchema,
	}, async (args) => logic.estimateCancel(envAny, props(), args));

	server.registerTool("restore_proforma", {
		title: "Restore a cancelled proforma",
		description: "Restore a previously cancelled proforma.",
		inputSchema: schemas.estimateRestoreSchema,
	}, async (args) => logic.estimateRestore(envAny, props(), args));

	server.registerTool("delete_proforma", {
		title: "Delete a proforma (confirm)",
		description: "Delete a proforma (only the last in the series). Must pass confirm:true.",
		inputSchema: schemas.estimateDeleteSchema,
	}, async (args) => logic.estimateDelete(envAny, props(), args));

	server.registerTool("restore_invoice", {
		title: "Restore a cancelled invoice",
		description: "Restore a previously cancelled invoice.",
		inputSchema: schemas.invoiceRestoreSchema,
	}, async (args) => logic.invoiceRestore(envAny, props(), args));

	server.registerTool("delete_invoice", {
		title: "Delete an invoice (confirm)",
		description: "Delete an invoice (only the last in the series). Must pass confirm:true.",
		inputSchema: schemas.invoiceDeleteSchema,
	}, async (args) => logic.invoiceDelete(envAny, props(), args));

	server.registerTool("list_stocks", {
		title: "List stock levels",
		description: "Inventory stock levels for a date (yyyy-MM-dd), optionally filtered by warehouse/product.",
		inputSchema: schemas.listStocksSchema,
	}, async (args) => logic.stocks(envAny, props(), args));

	server.registerTool("payment_text", {
		title: "Fiscal receipt data",
		description: "Get fiscal receipt data (bon fiscal) by internal id.",
		inputSchema: schemas.paymentTextSchema,
	}, async (args) => logic.paymentText(envAny, props(), args));

	server.registerTool("delete_payment", {
		title: "Delete a payment (confirm)",
		description: "Delete a non-receipt payment (paymentType case-sensitive: CEC not Cec). Must pass confirm:true.",
		inputSchema: schemas.paymentDeleteSchema,
	}, async (args) => logic.paymentDelete(envAny, props(), args));

	server.registerTool("delete_chitanta", {
		title: "Delete a receipt (confirm)",
		description: "Delete a chitanta receipt (only the last in the series). Must pass confirm:true.",
		inputSchema: schemas.chitantaDeleteSchema,
	}, async (args) => logic.chitantaDelete(envAny, props(), args));

	server.registerTool("convert_proforma", {
		title: "Convert a proforma into an invoice (confirm)",
		description: "Turn an accepted quote into a real invoice — pulls client and products from the proforma. Must pass confirm:true.",
		inputSchema: schemas.convertProformaSchema,
	}, async (args) => logic.convertProforma(envAny, props(), args));

	server.registerTool("client_balances", {
		title: "Per-client balances",
		description: "For every client: total issued, received, and outstanding — ranked by what they owe. Answer 'how much does X owe/pay me', 'who owes the most'.",
		inputSchema: schemas.clientBalancesSchema,
	}, async (args) => logic.clientBalancesTool(envAny, props(), args));

	server.registerTool("overdue_invoices", {
		title: "Overdue invoices + aging",
		description: "Past-due invoices with remaining balance, days overdue, and aging buckets (0-30/31-60/61-90/90+). Answer 'who's late', 'what's overdue'.",
		inputSchema: schemas.overdueSchema,
	}, async (args) => logic.overdueTool(envAny, props(), args));

	server.registerTool("due_invoices", {
		title: "Invoices due in a window",
		description: "Invoices whose DUE DATE falls in a range (default: today → +30 days). Answer 'what's due next week/month'. Filters by due_date, not issue_date.",
		inputSchema: schemas.dueInvoicesSchema,
	}, async (args) => logic.dueInvoicesTool(envAny, props(), args));
}
