import type { Env } from "../env";
import { getAuthUser } from "../auth/auth";
import { V1Client } from "../smartbill/client";
import { V3Client, V3NotConfiguredError } from "../smartbill/v3";
import type { SmartBillCreateInvoiceBody } from "../smartbill/types";
import { ensureTenant, getTenantForAuthUser, registerTenant, type TenantCreds } from "../ledger/tenant";
import {
	createInvoice,
	finalizeInvoice,
	getInvoiceBySeriesNumber,
	searchInvoices,
	countTotals,
	reconcile,
	getDraft,
	setStatus,
	recordPaymentAmount,
	clientBalances,
	overdueInvoices,
	writeUserAudit,
	countRecentUserEvents,
	syncLedgerRows,
	type InvoiceRow,
} from "../ledger/ledger";

export type ToolResult = { content: { type: "text"; text: string }[] };

function text(s: string): ToolResult {
	return { content: [{ type: "text", text: s }] };
}

function confirmRequired(tool: string, confirm: unknown): asserts confirm is true {
	if (confirm !== true) throw new Error(`confirm:true required for ${tool}`);
}

/** today in Europe/Bucharest as yyyy-MM-dd. */
function todayBucharest(): string {
	return new Date().toLocaleDateString("en-CA", { timeZone: "Europe/Bucharest" });
}
function plusDays(date: string, days: number): string {
	const d = new Date(`${date}T00:00:00`);
	d.setDate(d.getDate() + days);
	return d.toLocaleDateString("en-CA", { timeZone: "Europe/Bucharest" });
}

async function resolveCreds(env: Env, props: { login?: string; email?: string; name?: string } | undefined): Promise<TenantCreds> {
	const user = getAuthUser(props, env); // throws NotInvitedError on non-invited
	await ensureTenant(env, user); // owner: seeds D1 from SMARTBILL_* env on first run; non-owner: throws TenantNotFoundError
	return getTenantForAuthUser(env, user); // throws TenantNotFoundError
}

function v1(creds: TenantCreds): V1Client {
	return new V1Client({ email: creds.email, token: creds.token, cif: creds.cif });
}

function v3(creds: TenantCreds): V3Client {
	// V3 token is NOT stored in the tenant (deferred). With no token the V3 client
	// returns a typed V3NotConfiguredError rather than a raw 401.
	return new V3Client({ token: "", cif: creds.cif });
}

async function defaultSeries(creds: TenantCreds, type = "factura"): Promise<string> {
	const series = await v1(creds).listSeries(creds.cif, type);
	const invoiceSeries = series.find((s) => (s.type ?? type).toLowerCase() === type.toLowerCase()) || series[0];
	if (!invoiceSeries?.name) throw new Error("No invoice series configured in SmartBill — supply a series");
	return invoiceSeries.name;
}

// --- create_draft ---

export async function createDraft(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: {
	client?: { name: string; cif?: string; vatCode?: string; regCom?: string; email?: string; address?: string; city?: string; country?: string; phone?: string };
	client_id?: number;
	products?: { name: string; quantity?: number; unitPrice?: number; isTaxIncluded?: boolean; taxName?: string; taxPercentage?: number; translatedName?: string; translatedMeasuringUnit?: string; description?: string }[];
	series?: string;
	issueDate?: string;
	dueDate?: string;
	currency?: string;
	language?: string;
	idempotency_key?: string;
}): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const client = v1(creds);
	let clientRec = args.client;
	if (args.client_id) {
		try {
			const v3c = v3(creds);
			const list = await v3c.listClients(creds.cif, undefined, 100);
			const found = list.find((c) => String(c.id) === String(args.client_id));
			if (found) clientRec = { name: found.name ?? "", cif: found.code };
		} catch (e) {
			if (!(e instanceof V3NotConfiguredError)) throw e;
			// V3 disabled: fall back to provided client object
		}
	}
	if (!clientRec?.name) throw new Error("create_draft requires a client (name)");

	const series = args.series ?? (await defaultSeries(creds));
	const currency = args.currency ?? "RON";
	const issueDate = args.issueDate ?? todayBucharest();
	const dueDate = args.dueDate ?? plusDays(issueDate, 30);
	const products = (args.products ?? []).map((p) => ({
		name: p.name,
		quantity: p.quantity ?? 1,
		// Wire field is `price` (SmartBill rejects `unitPrice` with json_mapping_error).
		price: p.unitPrice ?? 0,
		isTaxIncluded: p.isTaxIncluded ?? false,
		// SmartBill matches VAT by taxName, NOT taxPercentage alone. The API's standard
		// names come from GET /tax (live-verified): 21% -> "Normala", 11% -> "Redusa",
		// 0% -> "Taxare inversa"/"TVA Inclus"/"SDD"/"SFDD". Default 21% -> "Normala".
		taxName: p.taxName ?? (p.taxPercentage === 11 ? "Redusa" : "Normala"),
		taxPercentage: p.taxPercentage ?? 21,
		// SmartBill REQUIRES measuringUnitName per product; "buc" is the universal default.
		measuringUnitName: "buc",
		translatedName: p.translatedName,
		translatedMeasuringUnit: p.translatedMeasuringUnit,
		description: p.description,
	}));

	const body: SmartBillCreateInvoiceBody = {
		companyVatCode: creds.cif,
		seriesName: series,
		isDraft: true,
		issueDate,
		dueDate,
		currency,
		language: args.language,
		client: {
			name: clientRec.name,
			cif: clientRec.cif,
			vatCode: clientRec.vatCode,
			regCom: clientRec.regCom,
			email: clientRec.email,
			address: clientRec.address,
			city: clientRec.city,
			country: clientRec.country,
		},
		products,
	};

	await client.createInvoice(body); // SmartBill draft
	const totalRon = (products ?? []).reduce((s, p) => s + (p.quantity ?? 1) * (p.price ?? 0), 0);
	const row = await createInvoice(env, getAuthUser(props, env).login, {
		series,
		isDraft: true,
		clientName: clientRec.name,
		clientCif: clientRec.cif,
		issueDate,
		dueDate,
		totalRon,
		currency,
		idempotencyKey: args.idempotency_key,
		draftPayload: JSON.stringify(body),
	});
	return text(
		`Draft created: Client ${clientRec.name} | Series ${series} | ${totalRon} ${currency} | draft_id ${row.draft_id}`,
	);
}

// --- finalize_invoice ---

export async function finalize(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { draft_id: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("finalize_invoice", args.confirm);
	const creds = await resolveCreds(env, props);
	const user = getAuthUser(props, env);
	const row = await finalizeInvoice(env, user.login, args.draft_id, {
		cif: creds.cif,
		create: (_cif, body) => v1(creds).createInvoice({ ...body, isDraft: false }).then((r) => ({ ...r })),
	});
	return text(`Invoice finalized: ${row.series}/${row.number} (issued)`);
}

// --- send_invoice ---

export async function sendInvoice(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { draft_id?: string; series?: string; number?: string; to?: string; cc?: string; subject?: string; bodyText?: string; docType?: "factura" | "proforma"; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("send_invoice", args.confirm);
	const creds = await resolveCreds(env, props);
	const user = getAuthUser(props, env);
	let series = args.series;
	let number = args.number;
	let clientEmail = args.to;

	if (args.draft_id) {
		const draft = await getDraft(env, user.login, args.draft_id);
		if (!draft) throw new Error(`Draft ${args.draft_id} not found`);
		if (!draft.draft_payload) throw new Error("Draft has no payload to resolve recipient");
		const payload = JSON.parse(draft.draft_payload) as { client?: { email?: string } };
		series = series ?? draft.series;
		number = number ?? draft.number ?? undefined;
		clientEmail = clientEmail ?? payload.client?.email;
	}
	if (!series || !number) throw new Error("send_invoice requires series + number (or a finalize draft_id)");
	if (!clientEmail) throw new Error("send_invoice requires a recipient `to` (no client email stored for this invoice)");

	await v1(creds).sendDocument({
		cif: creds.cif,
		seriesName: series,
		number,
		to: clientEmail,
		cc: args.cc,
		subject: args.subject ?? `Invoice ${series}/${number}`,
		bodyText: args.bodyText ?? "Plecare atasat.",
		type: args.docType ?? "factura",
	});
	const row = await getInvoiceBySeriesNumber(env, user.login, series, number);
	if (row) await writeUserAudit(env, user.login, row.id, "sent", user.login);
	return text(`Invoice ${series}/${number} sent to ${clientEmail}`);
}

// --- record_payment ---

export async function recordPayment(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string; type: string; value: number; currency?: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("record_payment", args.confirm);
	const creds = await resolveCreds(env, props);
	const user = getAuthUser(props, env);
	await v1(creds).recordPayment({
		companyVatCode: creds.cif,
		type: args.type,
		value: args.value,
		currency: args.currency,
		// Link the payment to the invoice; pull client details from it (SmartBill
		// rejects payments without client details unless useInvoiceDetails=true).
		useInvoiceDetails: true,
		invoicesList: [{ seriesName: args.series, number: args.number }],
	});
	const row = await getInvoiceBySeriesNumber(env, user.login, args.series, args.number);
	if (row) await recordPaymentAmount(env, user.login, args.series, args.number, args.value, user.login);
	return text(`Payment (${args.type}, ${args.value} ${args.currency ?? "RON"}) recorded for ${args.series}/${args.number}`);
}

// --- cancel_invoice / storno ---

export async function cancel(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("cancel_invoice", args.confirm);
	const creds = await resolveCreds(env, props);
	const user = getAuthUser(props, env);
	await v1(creds).cancelInvoice(creds.cif, args.series, args.number);
	await setStatus(env, user.login, args.series, args.number, "cancelled", user.login);
	return text(`Invoice ${args.series}/${args.number} cancelled`);
}

export async function storno(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("storno", args.confirm);
	const creds = await resolveCreds(env, props);
	const user = getAuthUser(props, env);
	await v1(creds).storno({ companyVatCode: creds.cif, seriesName: args.series, number: args.number });
	await setStatus(env, user.login, args.series, args.number, "storno", user.login);
	return text(`Invoice ${args.series}/${args.number} storno'd`);
}

// --- invoice_status ---

export async function invoiceStatus(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const user = getAuthUser(props, env);
	let ledger = await getInvoiceBySeriesNumber(env, user.login, args.series, args.number);
	// Self-heal: ledger row may still be a draft (number null) while SmartBill already
	// assigned the number — find the draft in the series and reconcile it.
	if (!ledger) {
		const drafts = await searchInvoices(env, user.login, { series: args.series, status: "draft" });
		if (drafts.length > 0) {
			ledger = (await reconcile(env, user.login, args.series, args.number)) ?? drafts[0];
		}
	}
	if (ledger && (ledger.status === "draft" || !ledger.number)) {
		ledger = (await reconcile(env, user.login, args.series, args.number)) ?? ledger;
	}
	const live = await v1(creds).paymentStatus(creds.cif, args.series, args.number);
	// Mirror live paid state into the ledger when it diverges.
	if (ledger && live.paid && ledger.status !== "paid") {
		await setStatus(env, user.login, args.series, args.number, "paid", user.login);
		ledger = await getInvoiceBySeriesNumber(env, user.login, args.series, args.number);
	}
	return text(
		`Invoice ${args.series}/${args.number}: ledger=${ledger?.status ?? "unknown"} | paid=${live.paid ?? false}`,
	);
}

// --- get_pdf ---

export async function pdf(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const buf = await v1(creds).getPdf(creds.cif, args.series, args.number);
	const bytes = new Uint8Array(buf);
	const b64 = bytesToBase64(bytes);
	if (b64.length > 2_000_000) throw new Error(`PDF for ${args.series}/${args.number} is too large to embed (${(b64.length / 1024).toFixed(0)} KB base64)`);
	return text(`PDF (base64, ${bytes.length} bytes):\n${b64}`);
}

// --- list_series / list_tax (V1 reads) ---

export async function series(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { type?: string }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const list = await v1(creds).listSeries(creds.cif, args.type);
	return text(JSON.stringify(list.map((s) => ({ seriesname: s.name, type: s.type, isDraft: s.isDraft }))));
}

export async function tax(env: Env, props: { login?: string; email?: string; name?: string } | undefined): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const list = await v1(creds).listTax(creds.cif);
	return text(JSON.stringify(list.map((t) => ({ percentage: t.percentage, name: t.name }))));
}

// --- list_clients / list_products (V3 reads) ---

export async function clients(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { name?: string; limit?: number }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	try {
		const v3c = v3(creds);
		const list = await v3c.listClients(creds.cif, args.name, args.limit ?? 50);
		return text(JSON.stringify(list));
	} catch (e) {
		if (e instanceof V3NotConfiguredError) return text("V3 token not configured — V3 reads disabled");
		throw e;
	}
}

export async function products(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { name?: string; code?: string; limit?: number }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	try {
		const v3c = v3(creds);
		const list = await v3c.listProducts(creds.cif, args.name, args.code, args.limit ?? 50);
		return text(JSON.stringify(list));
	} catch (e) {
		if (e instanceof V3NotConfiguredError) return text("V3 token not configured — V3 reads disabled");
		throw e;
	}
}

// --- search_invoices / count_totals ---

export async function search(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { client?: string; status?: string; from?: string; to?: string; text?: string }): Promise<ToolResult> {
	const user = getAuthUser(props, env);
	const rows = await searchInvoices(env, user.login, {
		client: args.client,
		status: args.status as never,
		from: args.from,
		to: args.to,
		text: args.text,
	});
	return text(JSON.stringify(rows.map((r) => ({
		id: r.id, draft_id: r.draft_id, series: r.series, number: r.number, status: r.status,
		client_name: r.client_name, total_ron: r.total_ron, currency: r.currency, issue_date: r.issue_date,
	}))));
}

export async function totals(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { month?: string; client?: string; status?: string; from?: string; to?: string }): Promise<ToolResult> {
	const user = getAuthUser(props, env);
	const res = await countTotals(env, user.login, { month: args.month, client: args.client, status: args.status as never, from: args.from, to: args.to });
	if (args.status || args.month || args.client || args.from || args.to) {
		const range = args.from || args.to ? ` in range ${args.from ?? "…"} → ${args.to ?? "…"}` : "";
		return text(`Count: ${res.count} | Sum: ${res.sum_total_ron} RON${range}`);
	}
	const breakdown = Object.entries(res.by_status)
		.map(([s, n]) => `${s}: ${n}`)
		.join(", ");
	return text(`You have ${res.count} invoice(s) in your ledger. Breakdown: ${breakdown}. Sum total: ${res.sum_total_ron} RON. (Ledger tracks invoices created through this MCP.)`);
}

// --- register_account ---

export async function registerAccount(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { email: string; token: string; cif: string; cif_fallback?: string; overwrite?: boolean }): Promise<ToolResult> {
	const user = getAuthUser(props, env);
	const recent = await countRecentUserEvents(env, user.login, "register_attempt");
	if (recent >= 5) throw new Error("Too many register_account attempts this hour — try again later");
	await writeUserAudit(env, user.login, null, "register_attempt", user.login);
	// Probe creds live with one list_series before storing
	const probe = new V1Client({ email: args.email, token: args.token, cif: args.cif });
	await probe.listSeries(args.cif, "factura");
	await registerTenant(env, user, { email: args.email, token: args.token, cif: args.cif, cifFallback: args.cif_fallback }, args.overwrite ?? false);
	return text("Account registered (SmartBill creds encrypted at rest)");
}

/** Upsert a batch of external invoice rows into the ledger (Facturi emise export sync). */
export async function syncLedger(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { rows: Array<{ series: string; number: string; issueDate?: string; dueDate?: string; clientName?: string; clientCif?: string; totalRon?: number; currency?: string; status?: string }>; replace?: boolean }): Promise<ToolResult> {
	const user = getAuthUser(props, env);
	const res = await syncLedgerRows(env, user.login, args.rows.map((r) => ({
		series: r.series,
		number: r.number,
		issueDate: r.issueDate,
		dueDate: r.dueDate,
		clientName: r.clientName,
		clientCif: r.clientCif,
		totalRon: r.totalRon,
		currency: r.currency,
		status: (r.status ?? "issued") as never,
	})), args.replace ?? false);
	return text(`Ledger sync complete: ${res.inserted} inserted, ${res.updated} updated`);
}

async function resolveSeries(creds: TenantCreds, requested?: string): Promise<string> {
	if (requested) return requested;
	const any = await new V1Client(creds).listSeries(creds.cif);
	const proforma = any.find((s) => s.type === "p");
	if (proforma?.name) return proforma.name;
	if (any[0]?.name) return any[0].name;
	throw new Error("no SmartBill document series configured — create one (Configurare → Serii) or pass series");
}

export async function createEstimate(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { client: { name: string; country?: string; vatCode?: string; regCom?: string; email?: string; address?: string; city?: string; phone?: string }; products: Array<{ name: string; quantity?: number; unitPrice?: number; isTaxIncluded?: boolean; taxName?: string; taxPercentage?: number; translatedName?: string; translatedMeasuringUnit?: string; description?: string }>; series?: string; issueDate?: string; dueDate?: string; currency?: string; taxPercentage?: number; language?: string; idempotency_key?: string }): Promise<ToolResult> {
	const user = getAuthUser(props, env);
	const creds = await resolveCreds(env, props);
	const series = await resolveSeries(creds, args.series);
	const hasProformaSeries = (await new V1Client(creds).listSeries(creds.cif)).some((s) => s.type === "p");
	if (!hasProformaSeries) {
		return text(`SmartBill account has no proforma series. Create one in SmartBill (Configurare → Serii → New series, type "Proforma"), then try again. Proforma PDFs cannot be issued without one.`);
	}
	const body: SmartBillCreateInvoiceBody = {
		companyVatCode: creds.cif,
		seriesName: series,
		isDraft: false,
		issueDate: args.issueDate ?? todayBucharest(),
		dueDate: args.dueDate ?? plusDays(args.issueDate ?? todayBucharest(), 30),
		currency: args.currency ?? "RON",
		language: args.language,
		client: { name: args.client.name, country: args.client.country ?? "Romania", vatCode: args.client.vatCode, regCom: args.client.regCom, email: args.client.email, address: args.client.address, city: args.client.city, phone: args.client.phone },
		products: args.products.map((p) => ({
			name: p.name,
			quantity: p.quantity ?? 1,
			price: p.unitPrice ?? 0,
			isTaxIncluded: p.isTaxIncluded ?? false,
			taxName: p.taxName ?? (args.taxPercentage === 11 ? "Redusa" : "Normala"),
			taxPercentage: p.taxPercentage ?? args.taxPercentage ?? 21,
			measuringUnitName: "buc",
			translatedName: p.translatedName,
			translatedMeasuringUnit: p.translatedMeasuringUnit,
			description: p.description,
		})),
	};
	const res = await new V1Client(creds).createEstimate(body);
	const number = res.number;
	const total = (body.products ?? []).reduce((s, p) => s + (p.quantity ?? 0) * (p.price ?? 0), 0);
	await writeUserAudit(env, user.login, null, `proforma_${series}_${number ?? "?"}`, user.login);
	return text(`Proforma created: series ${series} number ${number ?? "(draft)"} — client ${args.client.name}, ${total} ${body.currency ?? "RON"}. Say "invoice it" to convert to an invoice.`);
}

export async function estimateInvoices(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).estimateInvoices(creds.cif, args.series, args.number);
	if (res.areInvoicesCreated) {
		return text(`Yes — proforma ${args.series}/${args.number} was invoiced: ${(res.invoices ?? []).map((i) => `${i.series}/${i.number}`).join(", ")}`);
	}
	return text(`No — proforma ${args.series}/${args.number} has not been invoiced yet. Say "invoice it" to convert.`);
}

export async function estimatePdf(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const buf = await new V1Client(creds).getEstimatePdf(creds.cif, args.series, args.number);
	const bytes = new Uint8Array(buf);
	const b64 = bytesToBase64(bytes);
	if (b64.length > 2_000_000) throw new Error(`Proforma PDF for ${args.series}/${args.number} is too large to embed (${(b64.length / 1024).toFixed(0)} KB base64)`);
	return text(`Proforma PDF (base64, ${bytes.length} bytes):\n${b64}`);
}

export async function estimateCancel(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("cancel_proforma", args.confirm);
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).cancelEstimate(creds.cif, args.series, args.number);
	return text(`Proforma ${args.series}/${args.number} cancelled${res.message ? ": " + res.message : ""}`);
}

export async function estimateRestore(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).restoreEstimate(creds.cif, args.series, args.number);
	return text(`Proforma ${args.series}/${args.number} restored${res.message ? ": " + res.message : ""}`);
}

export async function estimateDelete(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("delete_proforma", args.confirm);
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).deleteEstimate(creds.cif, args.series, args.number);
	return text(`Proforma ${args.series}/${args.number} deleted${res.message ? ": " + res.message : ""}`);
}

export async function invoiceRestore(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).restoreInvoice(creds.cif, args.series, args.number);
	await setStatus(env, getAuthUser(props, env).login, args.series, args.number, "issued", "restored");
	return text(`Invoice ${args.series}/${args.number} restored`);
}

export async function invoiceDelete(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("delete_invoice", args.confirm);
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).deleteInvoice(creds.cif, args.series, args.number);
	await setStatus(env, getAuthUser(props, env).login, args.series, args.number, "cancelled", "deleted");
	return text(`Invoice ${args.series}/${args.number} deleted${res.message ? ": " + res.message : ""}`);
}

export async function stocks(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { date: string; warehouseName?: string; productName?: string; productCode?: string }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).listStocks(creds.cif, args.date, { warehouseName: args.warehouseName, productName: args.productName, productCode: args.productCode });
	if (res.length === 0) return text("No stock data for that filter. Try a different product/warehouse or a valid date.");
	return text(JSON.stringify(res.slice(0, 50).map((s) => ({ warehouse: s.warehouseName, type: s.warehouseType, product: s.productName, code: s.productCode, qty: s.quantity, unit: s.measuringUnitName })), null, 2));
}

export async function paymentText(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { id: string }): Promise<ToolResult> {
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).paymentText(creds.cif, args.id);
	return text(JSON.stringify(res));
}

export async function paymentDelete(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { paymentType: string; invoiceSeries?: string; invoiceNumber?: string; paymentDate?: string; paymentValue?: number; clientName?: string; clientCif?: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("delete_payment", args.confirm);
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).deletePayment(creds.cif, args);
	return text(`Payment deleted${res.message ? ": " + res.message : ""}`);
}

export async function chitantaDelete(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("delete_chitanta", args.confirm);
	const creds = await resolveCreds(env, props);
	const res = await new V1Client(creds).deleteChitanta(creds.cif, args.series, args.number);
	return text(`Receipt ${args.series}/${args.number} deleted${res.message ? ": " + res.message : ""}`);
}

export async function clientBalancesTool(env: Env, props: { login?: string; email?: string; name?: string } | undefined, _args?: unknown): Promise<ToolResult> {
	const user = getAuthUser(props, env);
	const balances = await clientBalances(env, user.login);
	if (balances.length === 0) return text("No issued invoices in the ledger yet.");
	const lines = balances.slice(0, 15).map((b) => `${b.client_name}: issued ${b.issued_ron} RON | paid ${b.paid_ron} | outstanding ${b.unpaid_ron} (${b.invoice_count} invoices)`);
	return text(`Client balances (top by outstanding):\n${lines.join("\n")}`);
}

export async function overdueTool(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { client?: string }): Promise<ToolResult> {
	const user = getAuthUser(props, env);
	const { invoices, buckets, total_unpaid_ron } = await overdueInvoices(env, user.login);
	const filtered = args.client ? invoices.filter((i) => i.client_name.toLowerCase().includes(args.client!.toLowerCase())) : invoices;
	if (filtered.length === 0) return text(`No overdue invoices${args.client ? ` for ${args.client}` : ""}.`);
	const top = filtered.slice(0, 10).map((i) => `${i.series}/${i.number} ${i.client_name}: ${i.unpaid_ron} RON (${i.days_overdue}d overdue, due ${i.due_date})`);
	const bucketLine = Object.entries(buckets).map(([k, v]) => `${k}d: ${v} RON`).join(" | ");
	return text(`Overdue: ${filtered.length} invoice(s), ${filtered.reduce((s, i) => s + i.unpaid_ron, 0)} RON total.\n${top.join("\n")}\nAging: ${bucketLine}${args.client ? "" : `\nAll clients overdue total: ${total_unpaid_ron} RON`}`);
}

export async function convertProforma(env: Env, props: { login?: string; email?: string; name?: string } | undefined, args: { series: string; number: string; invoiceSeries?: string; confirm?: unknown }): Promise<ToolResult> {
	confirmRequired("convert_proforma", args.confirm);
	const creds = await resolveCreds(env, props);
	const user = getAuthUser(props, env);
	const invoiceSeries = args.invoiceSeries ?? "SR";
	const res = await new V1Client(creds).createInvoice({
		companyVatCode: creds.cif,
		seriesName: invoiceSeries,
		useEstimateDetails: true,
		estimate: { seriesName: args.series, number: args.number },
	});
	const number = res.number;
	if (number) {
		await syncLedgerRows(env, user.login, [{
			series: invoiceSeries,
			number,
			status: "issued",
		}]);
		await writeUserAudit(env, user.login, null, `proforma_${args.series}/${args.number}_invoiced`, user.login);
	}
	return text(`Proforma ${args.series}/${args.number} converted to invoice: ${invoiceSeries}/${number}${res.documentUrl ? " — " + res.documentUrl : ""}`);
}

// helper
function bytesToBase64(bytes: Uint8Array): string {
	let binary = "";
	for (const b of bytes) binary += String.fromCharCode(b);
	return btoa(binary);
}
