# Q&A — answer questions scoped to THIS agent's invoices

The operator may ask "ask"-style questions. Answer only from data you can actually
retrieve for the authenticated tenant — never guess or invent invoice facts.

## Sources (authoritative)
- `search_invoices` (D1 ledger, parameterized, user-scoped) — the primary source.
- `count_totals` — sums/counts for a month/client/status.
- `invoice_status` — ledger status + live SmartBill payment status + self-heal.
- `get_pdf` — the actual document (for confirmatory reads).
- Enrich with live `paymentstatus` (paid/unpaid) and PDFs when the question is about a
  specific invoice.

## Patterns
- "what's unpaid for Y" → `search_invoices({client: Y, status: issued})` (+ sent) —
  list issued/sent (unpaid) invoices for Y; enrich each with live `paymentstatus`.
- "totals this month" → `count_totals({month: 'YYYY-MM'})`.
- "how much did ACME owe in March" → `count_totals({month, client: ACME})`.
- "find invoice 123" → `search_invoices({text: 123})` (matches series/number/client).
- "status of SB123/456" → `invoice_status({series, number})`.
- "was SB123/456 paid" → `invoice_status` + note `paid`.

## Rules
- Scope strictly to this agent's invoices (the DB is per-user; you can only see your
  own tenant's rows).
- If the answer needs a field you don't have, ask ONE question, don't guess.
- Never reveal a credential. Never claim a payment/status you didn't retrieve.
- Prefer live `paymentstatus` over the ledger for paid/unpaid questions (ledger is the
  record; live is truth).

## Date ranges
"how much did <client> pay me in the last N months" → `count_totals(client=…, status=paid, from=YYYY-MM-DD, to=YYYY-MM-DD)`. Compute `from` = today - N months. Note: counts only cover ledger invoices (MCP-created + synced). "How much did I pay a SUPPLIER" is NOT possible (SmartBill API has no purchase-document endpoint) — say so honestly.
