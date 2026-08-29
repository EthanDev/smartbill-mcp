# smartbill-mcp — Execution Status (tracked, updated 2026-08-29)

> Live source of truth for what's deployed and what remains. The full plan lives at `.omo/plans/smartbill-invoice-automation.md`.

## ✅ Done & verified

| Area | State | Evidence |
|---|---|---|
| Worker deployed | **LIVE** — https://smartbill-mcp.ethan1709.workers.dev (version cdab9839 / f0a872bf) | `curl /health` → `{"status":"ok"}` |
| OAuth gate | `/mcp` → 401 + `WWW-Authenticate: Bearer realm="OAuth"`; metadata discovery live (`/authorize`, `/token`, `/register`, refresh_token grant) | curl outputs in session |
| D1 ledger | `tenants` / `invoices` / `audit_events` migrated remotely (done by Mac Mini earlier, verified) | `wrangler d1 execute --remote` |
| Secrets | 8/10 set: SMARTBILL_EMAIL, SMARTBILL_TOKEN, SMARTBILL_CIF (RO47247261), SMARTBILL_CIF_FALLBACK (47247261), COOKIE_ENCRYPTION_KEY, ENCRYPTION_KEY, OWNER_GITHUB_LOGIN, ALLOWED_GITHUB_LOGINS | `wrangler secret list` |
| Live SmartBill smoke | `list_series` → series `SR` (next 26); `list_tax` → 21%/11% post-2025 rates; CIF `RO47247261` accepted | `.omo/evidence/smoke-live.ts` |
| Full lifecycle QA | draft (ciorna, doc 50515496) → finalize **SR 0026** → PDF (31,865 B, valid `%PDF-1.4`) → storno **SR 0027** → status reversed (paid:true) | `.omo/evidence/lifecycle-test*.ts`, `qa-invoice-0027.pdf` |
| Hermes config | `mcp_servers.smartbill-mcp` = `url: https://smartbill-mcp.ethan1709.workers.dev/mcp, auth: oauth` (native OAuth 2.1 PKCE, no static bearer) | `hermes mcp list` shows enabled |
| Skill | `accounting-invoicing` installed + enabled (6 files incl. conversation.md, upload-parse.md, approval-gate.md) | `hermes skills list` |
| F2 gate | 70/70 vitest, tsc clean, coverage 83.76% | `.omo/evidence/task-14-f2.log` |

## ⛔ Blocked — needs owner input

### 1. GitHub OAuth apps (THE single unblock for auth)
Worker is deployed and the OAuth server is armed, but the **GitHub identity-provider app** must exist so users can log in. GitHub allows creating OAuth apps ONLY in the web UI — cannot be automated.

**Create two apps at https://github.com/settings/developers → OAuth Apps → New OAuth App:**

| App name | Homepage URL (any) | Authorization callback URL |
|---|---|---|
| `smartbill-mcp` | `https://smartbill-mcp.ethan1709.workers.dev` | `https://smartbill-mcp.ethan1709.workers.dev/callback` |
| `smartbill-mcp-local` | `http://localhost:8788` | `http://localhost:8788/callback` |

Then paste to the agent:
```
PROD_CLIENT_ID=...
PROD_CLIENT_SECRET=...
LOCAL_CLIENT_ID=...
LOCAL_CLIENT_SECRET=...
```
After that: `wrangler secret put GITHUB_CLIENT_ID/SECRET`, fill `.dev.vars`, `hermes mcp login smartbill-mcp` (browser), Inspector smoke, chat-gated E2E.

### 2. Channels (deferred by owner)
Telegram (BotFather token + `hermes pairing approve telegram <CODE>`) and WhatsApp Cloud (Meta panel + `hermes whatsapp-cloud` wizard + cloudflared tunnel :8090). Required for the conversational UI + Todo 13 chat-gate + F3 email test.

### 3. Final token rotation (recommended)
The V1 token traveled through chat. After OAuth is wired and before real invoices: regenerate at `cloud.smartbill.ro/core/integrari/`, then update the D1 tenant row (re-encrypt with EXISTING ENCRYPTION_KEY) + `.dev.vars` + `wrangler secret put SMARTBILL_TOKEN`.

### 4. F3 manual QA
Owner sends ONE real invoice email via chat once channels are live.

## Housekeeping
- The QA draft (ciorna, documentId **50515496**) remains as an unnumbered draft in SmartBill — delete in web UI when convenient. Invoices SR 0026 + SR 0027 are the storno pair from QA (TEST client).
- `.dev.vars` (local) has real SMARTBILL_TOKEN + generated keys — gitignored, never commit.
- Branch: `dev` (default). All work committed + pushed.
