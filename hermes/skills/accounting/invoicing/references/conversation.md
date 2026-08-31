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
-## Wizard flow (multi-turn, ONE field per turn — never dump the form)
Trigger: `create`, `make it`, or any message that implies a NEW invoice but is missing
details ("invoice for ACME", "create an invoice", "bill Smith 250 RON"). If anything is
missing, ASK before you draft — never create a half-empty draft and never fill a field
by guessing.

Before drafting, the agent MUST have:
1. **Client** — resolve to an existing SmartBill client via `list_clients` (fuzzy name
   match; top-3 tap-able choices if ambiguous) OR capture exact name + CIF if new.
2. **Product line(s)** — at least one: name + quantity + unit price (VAT-exclusive by
   default). If the operator said "for services" / "for the usual", ask what line or
   offer the most-recent / most-used product (via `list_products`) — do NOT guess.
3. **Quantity per line** — if absent, ask "how many / for how many units?" (default 1
   ONLY when the operator explicitly said "1" or "one" or the verb was a service).
4. **VAT per line** — if absent, ask "VAT on <line>? (21% standard, or other)". The
   default 21% is NOT a guess when the operator asked us to pick — but confirm it in
   the same question. For EU/B2B also confirm whether VAT is included in the price.
5. **Currency / dates** — default RON / today / +30 (echo in the card; only ask if
   non-default).

Each turn asks for EXACTLY ONE missing field, as a short question (2-3 choices when
possible). Never list all remaining fields. If the operator's message contains several
fields at once, capture them all, then ask only for what's still missing.
Accept free text: "2x Widget 15 RON" → quantity=2, name=Widget, unitPrice=15.
If the operator answers with a single word that doesn't fit the current question,
re-ask ONCE (or recognize it as a value for the *next* field if unambiguous).

When all fields are present → ONE-line order summary + confirmation card:
```
Client: ACME SRL (RO12345678) | Lines: 2x Widget 15 RON, 1x Setup 250 RON | VAT 21% | Total: 280 RON
Reply 'yes' to create the draft, or 'no' to cancel
```
On "yes" → `create_draft` (+ gate on finalize if they also said issue/send).
"no" / "cancel" / "never mind" at ANY point → drop the wizard, no draft created.

st factura series, VAT 21%, RON, today) + a summary line.
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
