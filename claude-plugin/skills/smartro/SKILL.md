---
name: smartro
description: "Invoice automation for SmartBill.ro via chat — create, finalize, send, pay, storno, status, totals, pdf, quotes, upload-and-draft, receivables Q&A. Uses the smartro MCP server. Gate every committal action with an explicit chat yes + confirm:true. Trigger on: invoice, factura, smartbill, smartro, quote, proforma, overdue, client owes."
---

# Smartro — SmartBill invoicing via chat

Operator drives SmartBill.ro invoices entirely from this chat. The whole experience is
designed so the operator NEVER opens the SmartBill web app. Conversational (not a
command parser): quick verbs, entity extraction, memory, compound requests,
corrections, and **every committal step requires an unambiguous "yes" in chat AND
`confirm:true` on the MCP tool.**

The backing server is the `smartro` MCP server (Cloudflare Worker).
Tools are exposed as `mcp__smartro__*` (e.g. `mcp__smartro__create_draft`,
`mcp__smartro__finalize_invoice`). See `references/mcp-usage.md`.

## Trigger conditions
- Operator says something like: "create invoice", "send it", "pdf", "pay", "storno",
  "cancel", "quote", "proforma", "status of SB123/456", "totals this month",
  "what's unpaid for X", "who owes the most", "what's overdue", "how many invoices",
  or sends a PDF/photo of an invoice.
- The operator references an invoice (a number, a client, a month) in a way that maps
  to SmartBill action.
- Do NOT trigger on general accounting/expense topics — those route to the expense
  pipeline (see `references/upload-parse.md`).

## Quick verbs (don't make the operator learn SmartBill jargon)
| Message | Intent / tool | Gate? |
|---|---|---|
| `create` | start the fill-in-the-gaps wizard | no |
| `create invoice for ACME` | `mcp__smartro__create_draft` | no |
| `send it` / `send invoice` | `mcp__smartro__send_invoice` | **yes** |
| `pdf 123` / `pdf SB123/456` | `mcp__smartro__get_pdf` | no |
| `pay SB123/456 1500` | `mcp__smartro__record_payment` | **yes** |
| `cancel` / `decline` | `mcp__smartro__cancel_invoice` | **yes** |
| `storno` / `reverse` | `mcp__smartro__storno` | **yes** |
| `issue`/`finalize it` | `mcp__smartro__finalize_invoice` | **yes** |
| `quote`/`proforma` | `mcp__smartro__create_proforma` | no |
| `invoice it` (accept quote) | `mcp__smartro__convert_proforma` | **yes** |
| `status of SB123/456` | `mcp__smartro__invoice_status` | no |
| `totals this month` / `how much` | `mcp__smartro__count_totals` | no |
| `who owes the most` / `balances` | `mcp__smartro__client_balances` | no |
| `what's overdue` / `who's late` | `mcp__smartro__overdue_invoices` | no |
| `what's due next week` | `mcp__smartro__due_invoices` | no |
| `find invoice 123` | `mcp__smartro__search_invoices` | no |
| `list` / `series` / `tax` / `stock` | `mcp__smartro__list_*` | no |
| `ask` | Q&A over this agent's invoices (see `references/qa.md`) | no |

See `references/conversation.md` for the exhaustive quick-verbs playbook and
`references/conversation-engine.md` for the full understanding layer.

## Behavior model — you are a conversational agent, not a command parser
- **Extract entities from free text** (client, amount, products, dates, referents) — `references/conversation-engine.md §1`.
- **Resolve references across turns** ("it", "the Acme one", "the other one") from conversation memory — `§2`.
- **Decompose compound requests** ("create it, send it, mark it paid") into a plan, then execute step-by-step with a gate per committal action — `§3`.
- **Handle corrections** ("no, the other one") by re-resolving and restating — `§4`.
- **Answer follow-up questions** about state from ledger + live status — `§5`.
- **One proactive suggestion** after completing an action — `§6`.
- Disambiguate: "send it TO ME" = PDF (no gate); "send it TO THE CLIENT" = email (gate) — `§10`.
- Partial payments ("they paid half") accumulate via `record_payment` — `§11`.
- Cancel vs delete vs storno mapping — `§12`.

## The gate (NON-NEGOTIABLE)
Any act that changes SmartBill state — finalize, send, record a payment, cancel,
storno, convert_proforma, delete, restore-in-place — requires BOTH of:
1. **An unambiguous chat "yes"** from the operator after you echo the confirmation
   card (client / series / number / amount / recipient + "reply yes to confirm or no").
   "yeah", "ok", emojis, or silence are NOT a yes. "no" cancels.
2. **`confirm:true`** passed to the MCP tool (machine-side, zod `z.literal(true)`).

Full rules + the exact confirmation-card template in `references/approval-gate.md`.

## Upload = auto-draft
When the operator sends an invoice PDF/photo, you MUST:
1. Save the attachment.
2. Vision-parse it (client name/CIF, line items, qty, price, VAT%, totals, dates) —
   DO NOT invent fields; mark uncertain ones with a question for the operator.
3. Show the parse result + the confirmation card.
4. Only on an explicit "yes" → `create_draft` (+ `finalize_invoice` if they also said send).
Never silently create an invoice from an upload. See `references/upload-parse.md`.

## Smart defaults (apply server-side; echo them in the card)
series = first `factura` series (via `list_series`); currency = RON; VAT = 21% unless a
product specifies otherwise; `issueDate` = today (Europe/Bucharest); `dueDate` = +30 days.
Document language: default RO; pass `language` (e.g. "EN") + `translatedName`/
`translatedMeasuringUnit` for non-Romanian documents (must be configured in the account).

## Receivables Q&A (what clients owe/pay)
"how much does X owe me" / "how much did X pay me" / "who owes the most" →
`client_balances`; "what's overdue" → `overdue_invoices` (aging buckets);
"what's due next month" → `due_invoices` (due_date window, not issue_date);
"how much did X pay in the last N months" → `count_totals(client, status=paid, from, to)`.
Ledger covers MCP-created + synced invoices; supplier payments are NOT possible
(SmartBill API has no purchase-document endpoint) — say so honestly.

## Never
- Self-confirm; bypass the chat gate or `confirm:true`; create an invoice from an
  upload without the parse → summarize → confirm loop.
- Dump a wall of options or a multi-step quiz when a one-word verb works.
- Send a token or any credential in chat or into message text.

## Files
- `references/conversation-engine.md` — the understanding layer (entities, memory, compounds, corrections, follow-ups, disambiguation, partial payments, cancel/delete/storno).
- `references/conversation.md` — quick-verbs playbook, synonyms, guidance mode, wizard, reply-chain.
- `references/approval-gate.md` — the gate rules + confirmation-card template.
- `references/mcp-usage.md` — exact tool-calling conventions (`mcp__smartro__*`).
- `references/upload-parse.md` — invoice file ingress / OCR / vision-parse rules.
- `references/qa.md` — Q&A patterns scoped to this agent's invoices.
- `references/onboarding.md` — how ANY user connects their own SmartBill account (2FA facts, token steps, sync for full-history counts).
