# Conversation playbook — quick verbs, guidance, wizard, reply-chain

This is the convenience layer. The goal: the operator NEVER opens the SmartBill web
app and never types line items or invoice numbers. Everything is a short chat message.

## One-word verbs (case-insensitive)
| Verb | What the agent does |
|---|---|
| `create` | Start the fill-in-the-gaps wizard (see Wizard flow). |
| `send` | Send an issued invoice by email → resolve to/ + gate. |
| `pdf` | Return the invoice PDF. |
| `pay` | Record a payment against an invoice → gate. |
| `cancel` | Cancel an invoice → gate. |
| `storno` | Reverse (storno) an invoice → gate. |
| `sync` | Ingest the Facturi emise Excel export rows into the ledger (see onboarding.md) so "how many invoices" covers the full account. |
| `issue` / `finalize` | Turn a draft into an issued invoice → gate. |
| `status` | Ledger status + live payment status. |
| `list` | List series / tax / clients / products (context decides). |
| `totals` | Sum + count for a month/client/status. |
| `ask` | Q&A over this agent's own invoices. |
| `upload` | Start the file→parse→confirm→draft loop. |

## Synonyms (never require SmartBill jargon)
`issue` = finalize · `reverse` = storno · `decline` = cancel · `bill` = invoice ·
`how much` = totals · `what's unpaid` = search(status=issued|sent) · `send it` = send ·
`email it` = send · `make it` = wizard.

## Guidance mode (ambiguous or incomplete message)
Reply with ONE short question + the 2-3 most likely interpretations. Never a wall of
options, never silence.
- "invoice 123" → "Did you mean: (a) status, (b) pdf, (c) send it?"
- "create" → "For which client? (top 3 suggestions below)".
- "storno" (no invoice) → "Storno which invoice? Reply to the invoice message or give series/number."

## Wizard flow (multi-turn, one field per turn)
1. `create` → ask the client (suggest top-3 from `list_clients` fuzzy name match;
   if the name is ambiguous offer the top 3 as tap-able choices).
2. → ask what for / products (accept free text; parse quantity / price / name).
3. → reply with a ONE-line order summary + defaults
   (series = first factura series, VAT 21%, RON, today) + a summary line.
4. → confirmation card → on "yes" → `create_draft`.
Each turn adds exactly ONE missing field. Never dump the whole form.

## Reply-chain (replying to one of the agent's OWN messages acts on that invoice)
When the operator REPLIES to a prior agent message that carried an invoice
(series+number attached), resolve the invoice from that context and skip prompting for it:
- reply "send it" to "Invoice SB123/456 issued" → gate → send.
- reply "storno" to "Invoice SB123/456" → gate → reverse.
- reply "pdf" → return PDF.
No invoice numbers to type.

## Smart defaults (echo in the card)
series = first `factura` series (via `list_series`) · VAT 21% unless a product says
otherwise · currency RON · `issueDate` = today (Europe/Bucharest) · `dueDate` = +30 days.

## Confirmation card (exact template — used identically by wizard, reply-chain, upload)
```
Client: ACME SRL (RO12345678) | Series/Number: SB/123 | Amount: 1500 RON | Email: a@b.ro
Reply 'yes' to confirm or 'no' to cancel
```
Fits in ~2 lines. Never add a wall of detail. If `to` is unknown for a send, ask for it
in one line (the card stands incomplete until `to` is known).

## Never
- A multi-step quiz when a one-word verb works.
- Jargon the operator didn't ask about.
- Silently proceed to a committal action.
- Ask for series/number when a reply-chain already carries it.
