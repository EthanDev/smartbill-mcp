import type { Env } from "../env";
import type { SmartBillCreateInvoiceBody, SmartBillDocumentResponse } from "../smartbill/types";

export type InvoiceStatus = "draft" | "issued" | "sent" | "paid" | "cancelled" | "storno";

export interface InvoiceRow {
	id: number;
	draft_id: string | null;
	user_id: string;
	series: string;
	number: string | null;
	doc_type: string;
	status: InvoiceStatus;
	client_name: string | null;
	client_cif: string | null;
	issue_date: string | null;
	due_date: string | null;
	total_ron: number | null;
	currency: string;
	paid_ron: number | null;
	payment_date: string | null;
	pdf_path: string | null;
	idempotency_key: string | null;
	draft_payload: string | null;
	created_at: string | null;
	updated_at: string | null;
}

export interface CreateInvoiceInput {
	series: string;
	docType?: string;
	isDraft: boolean;
	clientName?: string;
	clientCif?: string;
	issueDate?: string;
	dueDate?: string;
	totalRon?: number;
	currency?: string;
	idempotencyKey?: string;
	draftPayload?: string;
}

export interface SyncRowInput {
	series: string;
	number: string;
	issueDate?: string;
	dueDate?: string;
	clientName?: string;
	clientCif?: string;
	totalRon?: number;
	currency?: string;
	status: InvoiceStatus;
}

/**
 * Upsert a batch of external invoice rows (e.g. from a Facturi emise Excel export)
 * into the ledger. Keyed on (user_id, series, number): existing rows are updated
 * (status/totals/dates), new rows are inserted as non-draft. Returns inserted/updated counts.
 */
export async function syncLedgerRows(env: Env, userId: string, rows: SyncRowInput[], replace = false): Promise<{ inserted: number; updated: number }> {
	if (replace) {
		await env.DB.prepare("DELETE FROM invoices WHERE user_id = ? AND number IS NOT NULL").bind(userId).run();
	}
	let inserted = 0;
	let updated = 0;
	for (const r of rows) {
		const existing = await env.DB.prepare("SELECT id FROM invoices WHERE user_id = ? AND series = ? AND number = ? LIMIT 1")
			.bind(userId, r.series, r.number)
			.first<{ id: number }>();
		if (existing) {
			const cur = await env.DB.prepare("SELECT issue_date, due_date, client_name, client_cif, total_ron, currency FROM invoices WHERE id = ?")
				.bind(existing.id).first<{ issue_date: string | null; due_date: string | null; client_name: string | null; client_cif: string | null; total_ron: number | null; currency: string | null }>();
			await env.DB.prepare(
				`UPDATE invoices SET status = ?, issue_date = ?, due_date = ?, client_name = ?, client_cif = ?, total_ron = ?, currency = ?, updated_at = datetime('now') WHERE id = ?`
			)
				.bind(
					r.status,
					r.issueDate ?? cur?.issue_date ?? null,
					r.dueDate ?? cur?.due_date ?? null,
					r.clientName ?? cur?.client_name ?? null,
					r.clientCif ?? cur?.client_cif ?? null,
					r.totalRon ?? cur?.total_ron ?? null,
					r.currency ?? cur?.currency ?? null,
					existing.id,
				)
				.run();
			updated++;
		} else {
			const row = await createInvoice(env, userId, {
				series: r.series,
				isDraft: false,
				clientName: r.clientName,
				clientCif: r.clientCif,
				issueDate: r.issueDate,
				dueDate: r.dueDate,
				totalRon: r.totalRon,
				currency: r.currency,
			});
			await env.DB.prepare("UPDATE invoices SET number = ?, status = ? WHERE id = ?")
				.bind(r.number, r.status, row.id)
				.run();
			inserted++;
		}
	}
	await writeUserAudit(env, userId, null, `sync_ledger:${inserted}i:${updated}u`, userId);
	return { inserted, updated };
}

export interface SearchFilters {
	client?: string;
	series?: string;
	status?: InvoiceStatus;
	from?: string;
	to?: string;
	text?: string;
}

function toRow(r: Record<string, unknown> | null): InvoiceRow | null {
	if (!r) return null;
	return r as unknown as InvoiceRow;
}

/** Create an invoice row. A draft gets a uuid draft_id; an issued doc needs series+number. */
export async function createInvoice(env: Env, userId: string, input: CreateInvoiceInput): Promise<InvoiceRow> {
	// Idempotency: if the same idempotency_key is already seen for this user, return that row.
	if (input.idempotencyKey) {
		const existing = await env.DB.prepare("SELECT * FROM invoices WHERE user_id = ? AND idempotency_key = ? LIMIT 1")
			.bind(userId, input.idempotencyKey)
			.first();
		if (existing) return toRow(existing as Record<string, unknown>)!;
	}

	const status: InvoiceStatus = input.isDraft ? "draft" : "issued";
	const draftId = input.isDraft ? crypto.randomUUID() : null;
	await env.DB.prepare(
		`INSERT INTO invoices (draft_id, user_id, series, number, doc_type, status, client_name, client_cif, issue_date, due_date, total_ron, currency, idempotency_key, draft_payload, created_at, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
	)
		.bind(
			draftId,
			userId,
			input.series,
			input.isDraft ? null : (input.idempotencyKey ?? null),
			input.docType ?? "factura",
			status,
			input.clientName ?? null,
			input.clientCif ?? null,
			input.issueDate ?? null,
			input.dueDate ?? null,
			input.totalRon ?? null,
			input.currency ?? "RON",
			input.idempotencyKey ?? null,
			input.draftPayload ?? null,
		)
		.run();

	const draftFilter = draftId ? "draft_id = ?" : "id = last_insert_rowid()";
	const res = await env.DB.prepare(`SELECT * FROM invoices WHERE user_id = ? AND ${draftFilter} LIMIT 1`)
		.bind(userId, ...(draftId ? [draftId] : []))
		.first();
	return toRow(res as Record<string, unknown>)!;
}

export async function getDraft(env: Env, userId: string, draftId: string): Promise<InvoiceRow | null> {
	const res = await env.DB.prepare("SELECT * FROM invoices WHERE user_id = ? AND draft_id = ? LIMIT 1")
		.bind(userId, draftId)
		.first();
	return toRow(res as Record<string, unknown>);
}

export async function getInvoiceBySeriesNumber(env: Env, userId: string, series: string, number: string): Promise<InvoiceRow | null> {
	const res = await env.DB.prepare("SELECT * FROM invoices WHERE user_id = ? AND series = ? AND number = ? LIMIT 1")
		.bind(userId, series, number)
		.first();
	return toRow(res as Record<string, unknown>);
}

export interface FinalizeSmb {
	create: (cif: string, body: SmartBillCreateInvoiceBody) => Promise<SmartBillDocumentResponse>;
}

/**
 * Finalize a draft: call SmartBill with isDraft:false reusing the stored draft body,
 * capture the returned series+number, UPDATE the row (number NULL -> real) and audit.
 */
export async function finalizeInvoice(
	env: Env,
	userId: string,
	draftId: string,
	smb: FinalizeSmb & { cif: string },
): Promise<InvoiceRow> {
	const draft = await getDraft(env, userId, draftId);
	if (!draft) throw new Error(`Draft ${draftId} not found`);
	if (draft.status !== "draft") throw new Error(`Draft ${draftId} is already ${draft.status}, cannot finalize`);
	if (!draft.draft_payload) throw new Error(`Draft ${draftId} has no storable payload to finalize`);

	const body = JSON.parse(draft.draft_payload) as SmartBillCreateInvoiceBody;
	const result = await smb.create(smb.cif, { ...body, isDraft: false });
	const series = result.seriesName ?? draft.series;
	const number = result.number;
	if (!number) throw new Error("SmartBill did not return a number on finalize");

	try {
		await env.DB.prepare(
			`UPDATE invoices SET series = ?, number = ?, status = 'issued', updated_at = datetime('now') WHERE draft_id = ? AND user_id = ? AND number IS NULL`,
		)
			.bind(series, number, draftId, userId)
			.run();
		await writeUserAudit(env, userId, draft.id, "finalized", userId);
	} catch (error) {
		// SmartBill succeeded (the invoice IS issued upstream) but the ledger write
		// failed — record a reconcile_needed marker so the divergence is surfaced.
		try {
			await writeUserAudit(env, userId, draft.id, "reconcile_needed", userId);
		} catch {
			// D1 is unavailable; nothing more we can persist.
		}
		throw error;
	}
	const updated = await getInvoiceBySeriesNumber(env, userId, series, number);
	return updated!;
}

/** Set a status + write an audit row. */
export async function setStatus(env: Env, userId: string, series: string, number: string, status: InvoiceStatus, actor: string): Promise<InvoiceRow | null> {
	await env.DB.prepare("UPDATE invoices SET status = ?, updated_at = datetime('now') WHERE user_id = ? AND series = ? AND number = ?")
		.bind(status, userId, series, number)
		.run();
	const row = await getInvoiceBySeriesNumber(env, userId, series, number);
	if (row) await writeUserAudit(env, userId, row.id, status, actor);
	return row;
}

/**
 * Record a received amount on an invoice (accumulates partial payments).
 * If the accumulated paid_ron reaches total_ron, also flips status to 'paid'.
 */
export async function recordPaymentAmount(env: Env, userId: string, series: string, number: string, amount: number, actor: string): Promise<InvoiceRow | null> {
	const row = await getInvoiceBySeriesNumber(env, userId, series, number);
	if (!row) return null;
	const paidSoFar = (row.paid_ron ?? 0) + amount;
	const fullyPaid = row.total_ron != null && paidSoFar >= row.total_ron - 0.005;
	await env.DB.prepare(
		"UPDATE invoices SET paid_ron = ?, payment_date = ?, status = ?, updated_at = datetime('now') WHERE user_id = ? AND series = ? AND number = ?"
	)
		.bind(paidSoFar, row.payment_date ?? new Date().toISOString().slice(0, 10), fullyPaid ? "paid" : row.status, userId, series, number)
		.run();
	const updated = await getInvoiceBySeriesNumber(env, userId, series, number);
	if (updated) await writeUserAudit(env, userId, updated.id, `payment:${amount}`, actor);
	return updated;
}

/** Parameterized search, scoped to the authenticated user. */
export async function searchInvoices(env: Env, userId: string, filters: SearchFilters): Promise<InvoiceRow[]> {
	let sql = "SELECT * FROM invoices WHERE user_id = ?";
	const params: unknown[] = [userId];
	if (filters.status) {
		sql += " AND status = ?";
		params.push(filters.status);
	}
	if (filters.series) {
		sql += " AND series = ?";
		params.push(filters.series);
	}
	if (filters.client) {
		sql += " AND (client_name LIKE ? OR client_cif LIKE ?)";
		params.push(`%${filters.client}%`, `%${filters.client}%`);
	}
	if (filters.from) {
		sql += " AND issue_date >= ?";
		params.push(filters.from);
	}
	if (filters.to) {
		sql += " AND issue_date <= ?";
		params.push(filters.to);
	}
	if (filters.text) {
		sql += " AND (series LIKE ? OR number LIKE ? OR client_name LIKE ? OR draft_payload LIKE ?)";
		params.push(`%${filters.text}%`, `%${filters.text}%`, `%${filters.text}%`, `%${filters.text}%`);
	}
	sql += " ORDER BY created_at DESC LIMIT 100";
	const res = await env.DB.prepare(sql).bind(...params).all<Record<string, unknown>>();
	return (res.results ?? []).map((r) => r as unknown as InvoiceRow);
}

/** D1 aggregation (confirm-free): SUM(total_ron) + COUNT for a month/client/status window. */
export async function countTotals(env: Env, userId: string, opts: { month?: string; client?: string; status?: InvoiceStatus; from?: string; to?: string }): Promise<{ sum_total_ron: number; count: number; by_status: Record<string, number> }> {
	let sql = "SELECT COALESCE(SUM(total_ron),0) AS sum_total_ron, COUNT(*) AS count FROM invoices WHERE user_id = ?";
	const params: unknown[] = [userId];
	if (opts.month) {
		sql += " AND strftime('%Y-%m', issue_date) = ?";
		params.push(opts.month);
	}
	if (opts.from) {
		sql += " AND issue_date >= ?";
		params.push(opts.from);
	}
	if (opts.to) {
		sql += " AND issue_date <= ?";
		params.push(opts.to);
	}
	if (opts.client) {
		sql += " AND client_name = ?";
		params.push(opts.client);
	}
	if (opts.status) {
		sql += " AND status = ?";
		params.push(opts.status);
	}
	const res = await env.DB.prepare(sql).bind(...params).first<{ sum_total_ron: number; count: number }>();
	const by_status: Record<string, number> = {};
	if (!opts.status) {
		const rows = await env.DB.prepare(
			"SELECT status, COUNT(*) AS n FROM invoices WHERE user_id = ? GROUP BY status"
		).bind(userId).all<{ status: string; n: number }>();
		for (const r of rows.results ?? []) by_status[r.status] = r.n;
	}
	return { sum_total_ron: res?.sum_total_ron ?? 0, count: res?.count ?? 0, by_status };
}

export interface ClientBalance {
	client_name: string;
	issued_ron: number;
	paid_ron: number;
	unpaid_ron: number;
	invoice_count: number;
}

/**
 * Per-client receivables: total issued, received (paid_ron), and outstanding
 * (issued - paid). Only counts issued/sent/paid rows (excludes draft/storno/cancelled).
 */
export async function clientBalances(env: Env, userId: string): Promise<ClientBalance[]> {
	const rows = await env.DB.prepare(
		`SELECT client_name,
		        COALESCE(SUM(total_ron),0) AS issued_ron,
		        COALESCE(SUM(paid_ron),0) AS paid_ron,
		        COALESCE(SUM(total_ron),0) - COALESCE(SUM(paid_ron),0) AS unpaid_ron,
		        COUNT(*) AS invoice_count
		 FROM invoices
		 WHERE user_id = ? AND status IN ('issued','sent','paid')
		 GROUP BY client_name
		 ORDER BY unpaid_ron DESC`
	).bind(userId).all<ClientBalance>();
	return (rows.results ?? []).map((r) => ({ ...r, issued_ron: r.issued_ron ?? 0, paid_ron: r.paid_ron ?? 0, unpaid_ron: r.unpaid_ron ?? 0, invoice_count: r.invoice_count ?? 0 }));
}

export interface OverdueInvoice {
	series: string;
	number: string;
	client_name: string;
	total_ron: number;
	paid_ron: number;
	unpaid_ron: number;
	due_date: string;
	days_overdue: number;
}

/**
 * Invoices past due with remaining balance, plus aging buckets (0-30, 31-60, 61-90, 90+).
 */
export async function overdueInvoices(env: Env, userId: string, today = new Date().toISOString().slice(0, 10)): Promise<{ invoices: OverdueInvoice[]; buckets: Record<string, number>; total_unpaid_ron: number }> {
	const rows = await env.DB.prepare(
		`SELECT series, number, client_name, total_ron, paid_ron, due_date
		 FROM invoices
		 WHERE user_id = ? AND status IN ('issued','sent') AND due_date IS NOT NULL AND due_date < ?
		 ORDER BY due_date ASC`
	).bind(userId, today).all<{ series: string; number: string; client_name: string; total_ron: number; paid_ron: number; due_date: string }>();
	const invoices: OverdueInvoice[] = (rows.results ?? []).map((r) => {
		const total = r.total_ron ?? 0;
		const paid = r.paid_ron ?? 0;
		const due = String(r.due_date);
		return {
			series: String(r.series),
			number: String(r.number),
			client_name: String(r.client_name ?? "?"),
			total_ron: total,
			paid_ron: paid,
			unpaid_ron: Math.max(0, total - paid),
			due_date: due,
			days_overdue: Math.max(0, Math.floor((Date.parse(today) - Date.parse(due)) / 86400000)),
		};
	}).filter((i) => i.unpaid_ron > 0);
	const buckets: Record<string, number> = { "0-30": 0, "31-60": 0, "61-90": 0, "90+": 0 };
	let total_unpaid_ron = 0;
	for (const i of invoices) {
		total_unpaid_ron += i.unpaid_ron;
		const d = i.days_overdue;
		if (d <= 30) buckets["0-30"] += i.unpaid_ron;
		else if (d <= 60) buckets["31-60"] += i.unpaid_ron;
		else if (d <= 90) buckets["61-90"] += i.unpaid_ron;
		else buckets["90+"] += i.unpaid_ron;
	}
	return { invoices, buckets, total_unpaid_ron };
}

/** Self-heal a draft/issued mismatch: if the ledger row is draft but SmartBill returned a number, reconcile. */
export async function reconcile(env: Env, userId: string, series: string, number: string): Promise<InvoiceRow | null> {
	await env.DB.prepare("UPDATE invoices SET status = 'issued', number = ?, updated_at = datetime('now') WHERE user_id = ? AND series = ? AND (number IS NULL OR number != ?)")
		.bind(number, userId, series, number)
		.run();
	const row = await getInvoiceBySeriesNumber(env, userId, series, number);
	if (row) await writeUserAudit(env, userId, row.id, "reconciled", userId);
	return row;
}

export async function writeUserAudit(env: Env, userId: string, invoiceId: number | null, event: string, actor: string): Promise<void> {
	await env.DB.prepare("INSERT INTO audit_events (invoice_id, user_id, event, actor, at) VALUES (?, ?, ?, ?, datetime('now'))")
		.bind(invoiceId, userId, event, actor)
		.run();
}

/** Throttle register_account to <=5 attempts/hour per user (basic sliding window via audit rows). */
export async function countRecentUserEvents(env: Env, userId: string, event: string, withinMinutes = 60): Promise<number> {
	const res = await env.DB.prepare(
		"SELECT COUNT(*) AS n FROM audit_events WHERE user_id = ? AND event = ? AND at >= datetime('now', ?)",
	)
		.bind(userId, event, `-${withinMinutes} minutes`)
		.first<{ n: number }>();
	return res?.n ?? 0;
}
