# Upload = auto-draft (invoice file ingress)

When the operator sends an invoice PDF or photo, NEVER silently create an invoice.
Always run the parse → summarize → confirm loop.

## Flow
1. **Save the attachment** locally (e.g. `~/Downloads` or a temp dir); note the path.
2. **Vision/OCR parse** it with the model's image capability (or OCR). Extract:
   client name + CIF/VAT code, line items (name/qty/unit price), VAT%, totals,
   `issueDate`, `dueDate`, currency, series/number.
   - **DO NOT invent fields.** Mark anything uncertain with a question for the operator.
   - If OCR is inconclusive, ask ONE question for the single missing field — never loop.
3. **Show the parse result** — a compact summary of what you read, with uncertain fields flagged.
4. **Show the confirmation card** (approval-gate.md template) with the parsed client/series/amount.
5. **On an explicit "yes"** → `create_draft` (and, only if the operator also said send,
   `finalize_invoice` after a separate yes). Otherwise leave it as a draft.
6. If the operator declines, discard; never persist a half-created invoice.

## RECEIPT / expense photo (important) — do NOT mix silently
A photo/PDF of a RECEIPT or an EXPENSE (not an invoice you issue) may route — with ONE
extra confirmation ("route this to the expense pipeline?") — to the existing
`accounting-automation` expense pipeline (OCR + CSV/ledger ingestion). Never route it
silently and never create a SmartBill invoice from an expense.

## Bridge references
- Existing secure-document-ingestion patterns: `~/.hermes/skills/automation/secure-document-ingestion/`.
- Expense pipeline: `productivity/accounting-automation` skill.

## Never
- Create an invoice from an upload without parse → summarize → confirm.
- Guess a field (especially client CIF, totals, or VAT) — mark uncertain and ask.
- Mix an expense into the invoice path without an explicit extra confirmation.
