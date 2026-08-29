# smartbill-mcp — Execution Status (tracked, updated 2026-08-29)

> Live source of truth for what's deployed and what remains. Full plan: `.omo/plans/smartbill-invoice-automation.md`.

## ✅ Done & verified

| Area | State | Evidence |
|---|---|---|
| Worker deployed | **LIVE** — https://smartbill-mcp.ethan1709.workers.dev (version 9a023454) | `curl /health` → `{"status":"ok"}` |
| OAuth | **COMPLETE** — 2 GitHub OAuth apps configured (prod + local), secrets set, dynamic registration + consent dialog verified, `hermes mcp login smartbill-mcp` authenticated | `hermes mcp test` → Connected, 15 tools |
| D1 ledger | `tenants` / `invoices` / `audit_events` migrated remotely | `wrangler d1 execute --remote` |
| Secrets | 10/10 set (SMARTBILL_*, GITHUB_CLIENT_*, COOKIE_ENCRYPTION_KEY, ENCRYPTION_KEY, OWNER/ALLOWED_GITHUB_LOGIN) | `wrangler secret list` |
| Live SmartBill | `list_series` → SR (type f); `list_tax` → 21% Normala / 11% Redusa; CIF RO47247261 accepted | `.omo/evidence/smoke-live.ts` |
| Full lifecycle QA | draft (ciorna) → finalize **SR 0026** → PDF (31,865 B valid) → storno **SR 0027** → status reversed | `.omo/evidence/lifecycle-test*.ts` |
| MCP live calls | `create_draft` via OAuth'd MCP → **"Draft created… SR"**; `finalize` w/o confirm:true → hard validation error (machine gate) | `.omo/evidence/mcp-gate-test.ts` |
| Bug found & fixed | `taxName` default was `"21%"` → SmartBill rejects; fixed to `"Normala"`/`"Redusa"` (regression test added, 71/71 tests, redeployed) | commit `8eb073d` |
| Hermes | OAuth token persisted (`~/.hermes/mcp-tokens/smartbill-mcp.json`), 15 tools connected, `mcp_servers.smartbill-mcp` = url + auth:oauth | `hermes mcp list/test` |
| Skill | `accounting-invoicing` installed + enabled (conversation.md, upload-parse.md, approval-gate.md, mcp-usage.md, qa.md) | `hermes skills list` |
| F2 gate | 71/71 vitest, tsc clean, coverage 83.76%+ | `.omo/evidence/task-14-f2.log` |

## ⛔ Remaining (needs owner)

### 1. Channels (deferred by owner — required for the conversational UI)
- **Telegram**: BotFather token → `TELEGRAM_BOT_TOKEN` in `~/.hermes/.env`; DM the bot; `hermes pairing approve telegram <CODE>`; `TELEGRAM_ALLOWED_USERS` + `TELEGRAM_ALLOW_ALL_USERS=false`.
- **WhatsApp Cloud**: `hermes whatsapp-cloud` wizard (Meta panel) + `cloudflared tunnel --url http://localhost:8090` + webhook verify.

### 2. Chat-gated E2E (Todo 13 remainder — once a channel is live)
Full conversational flow test through the skill: quick verbs (`create`, `pdf`, `send`, `storno`, `status`, `totals`), upload-parse, negative-gate (reply "yeah"/emoji/"no" → no finalize), confirmation card, reply-chain.

### 3. F3 manual QA
Owner sends ONE real invoice email via chat once channels are live.

### 4. Final token rotation (recommended)
The V1 token traveled through chat. After channels are wired and before real invoices: regenerate at `cloud.smartbill.ro/core/integrari/`, update the D1 tenant row (re-encrypt with EXISTING ENCRYPTION_KEY) + `.dev.vars` + `wrangler secret put SMARTBILL_TOKEN`.

## Housekeeping
- QA docs in SmartBill: draft ciorna (documentId 50515496, from the first lifecycle test) remains unnumbered — delete in web UI when convenient. SR 0026 + SR 0027 are the storno pair (TEST client). MCP-gate test draft cleaned from ledger.
- Tenant row: re-seeded from prod secrets after a key-mismatch fix (the Mini's E2E had used a different ENCRYPTION_KEY; current row decrypts fine).
- `.dev.vars` (local) has real SMARTBILL_TOKEN + LOCAL OAuth app creds + generated keys — gitignored.
- Branch: `dev` (default). All work committed + pushed (head: 8eb073d).
