# Approval gate — the committal action gate (NON-NEGOTIABLE)

Every action that mutates SmartBill state must clear BOTH gates. If either fails, do
NOT proceed.

## The two gates
1. **Chat gate** — an unambiguous explicit "yes" from the PAIRED operator AFTER you
   echo the confirmation card. Anything else is NOT a yes:
   - NOT a yes: "yeah", "yep", "ok", "sure", "k", "✓", "👍", "do it", "go", silence,
     or any emoji-only reply.
   - "yes" (or the operator's paired language equivalent) IS a yes.
   - "no" / "nope" / "cancel" = cancel; leave the draft/state untouched.
2. **Machine gate** — pass `confirm:true` (zod `z.literal(true)`) to the MCP tool.
   The tool refuses with `confirm:true required` if not present.

## Per-action confirmation card + gate
| Action (tool) | Requires chat yes + `confirm:true` | Card fields |
|---|---|---|
| `finalize_invoice` | yes | client, series, draft_id, amount |
| `send_invoice` | yes | series/number, to, cc, subject (if given) |
| `record_payment` | yes | series/number, type, value, currency |
| `cancel_invoice` | yes | series/number |
| `storno` | yes | series/number |

`create_draft`, `get_pdf`, `invoice_status`, `list_*`, `search_invoices`,
`count_totals`, `register_account` are NOT committal → no confirm gate (but never
silently create from an upload; see upload-parse.md).

## Confirmation card template (verbatim)
```
Client: <name> (CIF <cif>) | Series/Number: <series>/<number> | Amount: <amount> <currency> | Email: <to>
Reply 'yes' to confirm or 'no' to cancel
```
- Only echo fields that exist. For a finalize, echo client + series + draft_id + amount.
- For a send, if `to` is unknown, present the card with `to` blank and ask for it.
- Never clutter the card with raw API jargon.

## Rules
- The agent MUST ask the yes/no question in chat (never assume consent).
- The agent MUST echo a summary (client, series, number, amount, recipient) in that
  same message — the card IS the echo.
- Only call the tool with confirm:true AFTER the unambiguous chat "yes".
- "confirm" in scope means "finalize = create non-draft" — SmartBill has NO separate
  confirm endpoint; the chat yes is semantic, the confirm:true is the machine flag.
- If a gate fails, re-ask once concisely (never loop). If the operator is ambiguous,
  ask "yes or no?" — do NOT interpret silence as consent.

## Verification clue
In `wrangler tail` / the ledger `audit_events`, a committal action only appears after
a `confirm:true` call that followed a real "yes". A "yeah"/emoji/no must produce NO
`finalized`/`sent`/`paid`/`cancelled`/`storno` audit event.
