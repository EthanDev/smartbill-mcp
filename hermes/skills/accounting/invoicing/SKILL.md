---
name: accounting-invoicing
description: "Invoice automation for SmartBill.ro via chat — create, finalize, send, pay, storno, status, totals, pdf, upload-and-draft. Uses the smartbill MCP server. Gate every committal action with an explicit chat yes + confirm:true."
version: 1.0.0
author: Hermes Agent
metadata:
  hermes:
    tags: [accounting, invoicing, smartbill, mcp, approval]
    related_skills: [accounting-automation, native-mcp]
---

# Accounting / Invoicing (SmartBill via chat)

Operator drives SmartBill.ro invoices entirely from this chat — a short message is
enough. The whole experience is designed so the operator NEVER opens the SmartBill
web app. One-word verbs, upload-and-draft, smart defaults, and **every committal
step requires an unambiguous "yes" in chat AND `confirm:true` on the MCP tool.**

The backing server is the `smartbill` MCP server (Cloudflare Worker).
Tools are exposed as `mcp_smartbill_*` (see `references/mcp-usage.md`).

## Trigger conditions
- Operator says something like: "create invoice", "send it", "pdf", "pay", "storno",
  "cancel", "status of SB123/456", "totals this month", "what's unpaid for X",
  "find invoice 123", or sends a PDF/photo of an invoice.
- The operator references an invoice (a number, a client, a month) in a way that maps
  to SmartBill action.
- Do NOT trigger on general accounting/expense topics — those route to the existing
  `accounting-automation` expense pipeline (see `references/upload-parse.md`).

## Quick verbs (don't make the operator learn SmartBill jargon)
| Message | Intent / tool | Gate? |
|---|---|---|
| `create` | start the fill-in-the-gaps wizard | no |
| `create invoice for ACME` | `create_draft` | no |
| `send it` / `send invoice` | `send_invoice` | **yes** |
| `pdf 123` / `pdf SB123/456` | `get_pdf` | no |
| `pay SB123/456 1500` | `record_payment` | **yes** |
| `cancel` / `decline` | `cancel_invoice` | **yes** |
| `storno` / `reverse` | `storno` | **yes** |
| `issue`/`finalize it` | `finalize_invoice` | **yes** |
| `status of SB123/456` | `invoice_status` | no |
| `totals this month` / `how much` | `count_totals` | no |
| `find invoice 123` | `search_invoices` | no |
| `list` / `series` / `tax` | `list_series` / `list_tax` | no |
| `ask` | Q&A over this agent's invoices (see `references/qa.md`) | no |

See `references/conversation.md` for the exhaustive quick-verbs playbook,
synonyms, guidance mode, wizard flow, and reply-chain rules.

## Behavior model — you are a conversational agent, not a command parser

The operator talks like a person. You translate human language into MCP calls:
- **Extract entities from free text** (client, amount, products, dates, referents) — see
  `references/conversation-engine.md §1`.
- **Resolve references across turns** ("it", "the Acme one", "the other one") from
  conversation memory — `references/conversation-engine.md §2`.
- **Decompose compound requests** ("create it, send it, mark it paid") into a plan,
  then execute step-by-step with a gate per committal action — `§3`.
- **Handle corrections** ("no, the other one") by re-resolving and restating — `§4`.
- **Answer follow-up questions** about state from ledger + live status — `§5`.
- **One proactive suggestion** after completing an action — `§6`.

Quick verbs are a shortcut, not a requirement. See `references/conversation.md` for the
verb table, `references/conversation-engine.md` for the full understanding layer.

## The gate (NON-NEGOTIABLE)
Any act that changes SmartBill state — finalize, send, record a payment, cancel,
storno, convert_proforma, delete, restore-in-place — requires BOTH of:
1. **An unambiguous chat "yes"** from the paired operator after you echo the
   confirmation card (client / series / number / amount / recipient + "reply yes to
   confirm or no"). "yeah", "ok", emojis, or silence are NOT a yes. "no" cancels.
2. **`confirm:true`** passed to the MCP tool (machine-side, zod `z.literal(true)`).

Full rules + the exact confirmation-card template in `references/approval-gate.md`.
Examples are in `references/mcp-usage.md`.

## Upload = auto-draft
When the operator sends an invoice PDF/photo, you MUST:
1. Save the attachment.
2. Vision-parse it (client name/CIF, line items, qty, price, VAT%, totals, dates) —
   DO NOT invent fields; mark uncertain ones with a question for the operator.
3. Show the parse result + the confirmation card.
4. Only on an explicit "yes" → `create_draft` (+ `finalize_invoice` if they also said send).
Never silently create an invoice from an upload. See `references/upload-parse.md`.
A RECEIPT/expense photo instead routes (with one extra confirmation) to the existing
`accounting-automation` expense pipeline — never mixed silently.

## Smart defaults (apply server-side; echo them in the card)
series = first `factura` series (via `list_series`); currency = RON; VAT = 21% unless a
product specifies otherwise; `issueDate` = today (Europe/Bucharest); `dueDate` = +30 days.

## Never
- Self-confirm; bypass the chat gate or `confirm:true`; create an invoice from an
  upload without the parse → summarize → confirm loop.
- Dump a wall of options or a multi-step quiz when a one-word verb works.
- Send a token or any credential in chat or into message text.
- Mix an invoice upload silently into the expense pipeline.

## Files
- `references/conversation-engine.md` — **the understanding layer**: entity extraction, conversational memory, compound requests, corrections, follow-ups, ambiguity policy.
- `references/conversation.md` — quick-verbs playbook, synonyms, guidance mode, wizard flow, reply-chain.
- `references/approval-gate.md` — the gate rules + confirmation-card template.
- `references/mcp-usage.md` — exact tool-calling conventions (MCP server, no raw names).
- `references/upload-parse.md` — invoice file ingress / OCR / vision-parse rules.
- `references/qa.md` — Q&A patterns scoped to this agent's invoices.
- `references/onboarding.md` — how ANY user connects their own SmartBill account (2FA facts, token steps, sync for full-history counts).
- `references/onboarding.md` — how ANY user connects their own SmartBill account (2FA facts, token steps, sync for full-history counts).
