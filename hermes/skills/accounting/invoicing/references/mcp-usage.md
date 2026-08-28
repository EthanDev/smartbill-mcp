# MCP usage — tool-calling conventions for the smartbill server

The `smartbill` MCP server (Cloudflare Worker) is exposed to Hermes over Streamable
HTTP. Tools are auto-discovered/registered as `mcp_smartbill_*` after Hermes connects
(see `native-mcp` skill for config + a connectivity curl probe).

## Tool names (server-registered; Hermes prefix `mcp_smartbill_`)
`create_draft` · `finalize_invoice` · `send_invoice` · `record_payment` ·
`cancel_invoice` · `storno` · `invoice_status` · `get_pdf` · `list_series` ·
`list_tax` · `list_clients` · `list_products` · `search_invoices` · `count_totals` ·
`register_account`

## Conventions
- Provide args as a JSON object (zod validates; unknown fields are stripped).
- **Committal tools MUST pass `confirm:true`** — the tool rejects otherwise
  (`confirm:true required`). The agent only passes it after the chat "yes".
- `series` + `number` are required for status/pdf/send/payment/cancel/storno.
  A draft has NO number — use `draft_id` for finalize.
- `list_clients` / `list_products` are **V3 reads**. If no V3 token is configured the
  server returns the literal `V3 token not configured — V3 reads disabled` string.
  Treat that as "feature disabled", not an error.
- `search_invoices` / `count_totals` query the D1 ledger — scoped to the authenticated
  user (never another tenant). `count_totals` is confirm-free.
- `register_account` probes the creds with one `list_series` before storing; throttled
  to 5 attempts/hour per user; needs `overwrite:true` to replace an existing tenant.

## Autocomplete rule
Before `create_draft`, call `list_clients` (and `list_products`) for fuzzy name
matching. NEVER pass a raw, possibly-ambiguous name string — when 2+ clients match
>70%, ask the operator to pick (offer the top 3). Use the returned id as `client_id`
so the server pulls the full client record.

## Never
- Send a token / email / any credential as a tool argument or in output text.
- Pass a raw name that could be ambiguous.
- Log or surface a server secret (server already never returns credentials).
