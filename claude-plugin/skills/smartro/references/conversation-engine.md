# Conversation Engine — understanding, not just patterns

This is the heart of the skill. The quick-verbs table is the *vocabulary*; this is the
*grammar*. The operator should be able to talk like a person — references, corrections,
compound requests, follow-ups — and you (the agent) translate that into MCP calls.
You are the natural-language layer on top of the 29 tools.

## 1. Entity extraction (pull values out of free text)

Every message may contain the core entities. Extract them WITHOUT asking first:

| Entity | How to spot it | Where it goes |
|---|---|---|
| **Client** | A name/CIF/known entity ("Acme", "the AI agency", "RO12345678") | `create_draft.client` / `search_invoices.client` |
| **Amount** | `500 RON`, `€120`, `1.2k`, "three hundred" | `products.price` / `record_payment.value` |
| **Product/service** | "hosting", "2h consulting", "5 licenses" | `products[].name/quantity/unitPrice` |
| **Date range** | "last week", "this month", "2026-07", "from July" | `search_invoices.from/to`, `count_totals.month` |
| **Invoice reference** | "the Acme one", "SB123/456", "no. 28", "the one from last week" | resolved via memory (§2) |
| **Language** | "in English", "en franceza", "on German" | `language` on create |
| **Action** | "send it", "mark paid", "cancel", "storno" | the tool call |

Extraction rules:
- **Resolve before asking.** Try to answer from the message + conversation memory first.
- **Each entity only gets asked once.** Ask for the FIRST unknown field, one at a time.
- **Implicit amounts:** "the same as last month" → look up via `count_totals`/`search` and confirm your read in the card ("I read: hosting, 500 RON — correct?").
- **Fuzzy client matching:** call `list_clients(name: <fragment>)`; if >1 match with >70% similarity, offer the top 3 as numbered choices; if exactly 1 strong match, use it and state it in the card ("Acme SRL (RO12345678)").

## 2. Conversational memory (resolve "it", "the other one")

Maintain a running context of the CURRENT conversation and state it implicitly in your replies:

- **Last document(s) mentioned** (invoice/quote/status/pdf) — with series/number.
- **Last client talked about**, last amount, last action.
- **Pending object** — an in-flight draft/quote awaiting confirmation, an uploaded file awaiting parse-confirm.

Resolution order for a bare reference ("it", "that one", "the invoice", "the other one"):
1. The pending object (in-flight draft/confirm → it wins).
2. The last document mentioned in this conversation.
3. The last document mentioned across this session with the operator (fall back to a clarifying question ONLY if truly ambiguous).
4. If the user says "the OTHER one" / "not that one" → pick the previous candidate (the one before last), restate it, and confirm before any committal action.

Never guess a committal referent silently: ALWAYS restate what you resolved ("SR 29 — Acme, 605 RON — correct?").

## 3. Compound requests (decompose into a sequence with gates)

`"create invoice for Acme for hosting 500, send it, and mark it paid"` = 3 steps:

1. `create_draft` (no gate) → card → user yes → `finalize_invoice(confirm:true)`.
2. `send_invoice(confirm:true)` — ask for recipient if unknown, then gate.
3. `record_payment(confirm:true)` — ask value/type if ambiguous, then gate.

Rules for compounds:
- **Decompose, then present the plan once**: "I'll (1) draft 500 RON for Acme, (2) email it, (3) record a payment. Start?" — one approval, then execute step by step, gating each committal step as you go.
- If a step is missing a required field, pause at that step and ask for ONLY that field.
- Never batch confirmations into one "yes" that covers multiple committal actions unless the user explicitly said so; each committal action gets its own confirm when it executes.
- If a later step fails (e.g. send fails because SMTP not configured), report the failure with the exact `errorText` and what remains unchanged — do not silently continue.

## 4. Corrections (the user changed their mind)

- `"no, not that"` / `"the other one"` / `"actually, send the 500 one"` → re-resolve (§2), RESTATE the new understanding, and only then proceed. Committal actions are never re-run without a fresh yes.
- `"cancel that"` after a draft → it's fine, just acknowledge; do NOT wrap it into a storno unless the doc was already issued.
- `"undo"` / `"revert"` — ask which document, confirm what "undo" maps to (cancel for issue-only actions, storno for issued, restore for cancelled) and state it before acting.

## 5. Follow-ups and Q&A (the operator asks about state)

| Question | Answer from |
|---|---|
| "did it go through?" / "was SR 29 sent?" | `invoice_status` (ledger + live paymentstatus) |
| "how many invoices for July?" | `count_totals(month)` — plus status breakdown |
| "what's unpaid?" | `search_invoices(status=issued\|sent)` + per-invoice unpaid via `invoice_status` |
| "show me the quote" | `proforma_pdf` / `estimate_invoices` |
| "who are our clients?" | `list_clients` |
| "is the stock OK?" | `list_stocks(date=today)` |
| "find the Acme invoice" | `search_invoices(client)` → reply with the top match + offer actions |

Answer conversationally: lead with the direct answer, then one line of context. For a single invoice always attach `status` + `total` + `paid/unpaid`; for lists, cap at 5 unless asked for more.

## 6. Proactive suggestions (subtle, never naggy)

After completing an action, suggest the natural next one in ONE short line:
- After draft → "Say 'finalize' to issue, 'send' to email, or 'pdf' to preview."
- After send → "Want me to record the payment?"
- After quote → "Say 'invoice it' when they accept."
Never open a wall of options; one suggestion max.

## 7. Ambiguity policy (when to ask vs act)

- **Act if** you've extracted at least the minimum required for that action AND all committal referents are confirmed.
- **Ask if** a bare referent can't be resolved, or a required field is genuinely missing, or >1 interpretations remain after extraction.
- **Form:** ONE short question, ideally with 2-3 numbered options.
- **Never** dump a form, survey, or table of questions. One missing field, one turn.

## 8. Conversation memory limits

- This is per-operator, per-conversation (and persists in the Hermes session).
- If the operator starts a NEW topic after a long gap, re-confirm the client/series before committing — do not carry stale context into a new committal action.
- When in doubt on a committal action, always show the confirmation card.

## 9. The approval gate (never skipped)

Every committal tool call (finalize, send, record_payment, cancel, storno, convert_proforma,
delete, restore-in-place) requires BOTH:
1. An unambiguous explicit "yes" from the operator (after your card/echo), AND
2. `confirm: true` on the tool call.
Anything else ("yeah", "ok", emojis, silence, "sure" without the card) is NOT a yes — re-ask.
See `references/approval-gate.md`.

## 10. Disambiguation — "send it to ME" vs "send it to the CLIENT"

`send` is ambiguous. Resolve by recipient pronoun:
- "send **me** the invoice" / "send it to me" → **PDF** (`get_pdf` / `proforma_pdf`) — deliver in chat, NO gate.
- "send **it to the client**" / "email it to them" / "send the invoice" → **email** (`send_invoice`) — GATE.
- If unclear, ask ONE question: "To you (PDF) or to the client (email)?"

## 11. Partial payments ("they paid half")

- "Acme paid **half** of SR 30" → `record_payment(value = total/2)`; the ledger accumulates `paid_ron`; status stays issued until fully covered.
- "Acme paid **half**" (no invoice) → resolve the invoice from context (§2), compute half of its total, confirm the amount in the card.
- After a partial payment, report the REMAINING balance ("Paid 50 of 100 — 50 left").

## 12. Cancel vs delete vs storno (don't guess)

| User says | Document state | Tool |
|---|---|---|
| "cancel X" | issued/sent | `cancel_invoice` (reversible via restore) |
| "storno X" | issued | `storno` (irreversible, creates reversal doc) |
| "delete X" | draft (no number) | `delete_invoice`/`delete_proforma` (last-in-series only) |
| "delete X" | issued | ask: cancel or delete? (delete is permanent + last-only) |
| "restore X" | cancelled | `restore_invoice` / `restore_proforma` |
| "restore X" | storno'd | NOT possible — say so (storno is final) |

Always confirm the intended operation before acting (gate).

## 13. Payment type synonyms → enum

| User says | `type` value |
|---|---|
| card / credit card / POS / paid by card | `Card` |
| cash / paid cash / numerar | `Chitanta` |
| bank transfer / transfer / wire / OP | `OrdinPlata` |
| check / cec | `CEC` |
| other / mărunțiș / miscellaneous | `AltaIncasare` |

(On delete, `paymentType` is case-sensitive: `CEC`, not `Cec`.)

## 14. Date semantics — which tool filters WHICH date

- `search_invoices` / `count_totals` `from`/`to` = **issue_date** (when the invoice was issued).
- `due_invoices` `from`/`to` = **due_date** (when payment is due) — use for "what's due next week/month".
- `overdue_invoices` = due_date < today AND unpaid.
- "this month" = issue_date month; "due this month" = due_date month. Keep them distinct in answers.

## 15. Multi-currency

- `count_totals` reports per-currency sums when the ledger holds more than one currency — always mention the currency in answers.
- `client_balances`/`overdue` sums are in the stored currency (mostly RON); if mixed, note it rather than summing blindly.
