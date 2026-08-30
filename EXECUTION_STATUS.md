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

## 2026-08-29 — multi-tenant + conversational Q&A extension (DONE)

**Now anyone can connect their own SmartBill account:**
- `OPEN_REGISTRATION=true` deployed — any authenticated GitHub user may use the MCP; they bind their OWN SmartBill creds via `register_account` (live-probed, AES-GCM encrypted at rest, throttled 5/hr, overwrite-guarded). Allowlist mode remains available (set OPEN_REGISTRATION=false + ALLOWED_GITHUB_LOGINS) for invite-only.
- **2FA answer (verified from official docs):** SmartBill 2FA affects ONLY web login + a closed list of portal ops (IBAN changes, adding users, account info, password reset). API tokens work over static Basic auth with NO 2FA code — enabling 2FA never blocks the MCP. User flow: log in (2FA here if on) → Contul meu → Integrări → copy email + token + CIF → register_account. Plan-gating note: online-store API is documented for Facturare Platinum. Rate limit 3 calls/sec, 10-min block, account-wide → per-tenant throttle.
- **Conversational Q&A live-verified:** `count_totals` → "You have N invoice(s)... Breakdown: issued: X, paid: Y, storno: Z. Sum total: RON." (status breakdown added). `search_invoices`, `sync_ledger` (Facturi emise Excel export → full-account counts; API has NO list endpoint — verified, 30 paths, zero invoice-listing).
- New MCP tool: `sync_ledger` (16 tools total). New skill ref: `references/onboarding.md` + `sync` verb in conversation.md.
- Bugs fixed during live E2E: FakeDB INSERT literal alignment; createInvoice SELECT conditional bind (D1 "wrong number of parameter bindings" on the sync path); subquery → last_insert_rowid for number assignment.
- Deployed: version a014206d. Tests: 75/75, tsc clean.

## 2026-08-29 — conversational expansion: proforma + stocks + restore/delete (DONE)

**12 new MCP tools (28 total), deployed (version 8c2d6219):**
- **Proforma lifecycle:** create_proforma, estimate_invoices ("was my quote invoiced?"), proforma_pdf, cancel_proforma, restore_proforma, delete_proforma. SmartBill requires a "proforma" series configured in the account — voice emails/chat guidance now tells users exactly how (Configurare → Serii). VOICEVUI currently has NO proforma series (only SR/f) → create one to use proformas.
- **Inventory:** list_stocks (date required yyyy-MM-dd; filters warehouse/product; unwraps {list:[]} envelope — live-verified).
- **Invoice restore/delete:** restore_invoice (undo cancel), delete_invoice (last-in-series, confirm).
- **Payments:** payment_text (fiscal receipt), delete_payment (paymentType case-sensitive at delete: CEC not Cec), delete_chitanta (confirm gates).
- Confirm-required on all destructive ops. Tests 83/83, tsc clean.

## 2026-08-30 — proforma quote→convert E2E (PASS, cleaned up)

**Full live E2E verified end-to-end (TEST client, cleaned after):**
1. `list_series` → SR (f) + **SRP (p)** — proforma series created by owner ✓
2. `create_proforma` → "Proforma created: series SRP number 0001 — client TEST QUOTE E2E - DELETE, 12.5 RON" ✓
3. `proforma_pdf` → 32,847 B valid PDF ✓
4. `estimate_invoices` (before) → "No — not yet invoiced" ✓
5. **Convert** (invoice body with `estimate: {seriesName, number}` + `useEstimateDetails: true`) → **SR 0028** issued (documentId 50535654), client/products pulled from proforma ✓
6. `estimate_invoices` (after) → "Yes — proforma SRP/0001 was invoiced: SR/0028" ✓
7. `get_pdf` SR 0028 → 32,869 B valid ✓
8. **Cleanup** → storno SR 0028 (→ SR 0029 reversal), proforma SRP/0001 deleted ("stearsa cu succes"), ledger + audit rows purged ✓

**Bugs found + fixed during E2E:**
- Query params must be lowercase `seriesname` (not `seriesName`) for delete/cancel/restore — spec error surfaced live. Committed `fe94a85`.
- Invoice body now supports `estimate` + `useEstimateDetails` for proforma→invoice conversion. Committed `d88fabc`.
- `send_invoice` accepts `docType` (factura|proforma) — spec: `type` selects document type; sending proforma with `type: factura` → "Documentul nu a fost gasit". Committed `6a7f5e6`.

**State:** SR nextNumber 30, SRP nextNumber 1. Tests 83/83, tsc clean, deployed (version 6ad31b06). Owner's real invoice was not touched; all E2E docs are TEST + storno'd/deleted.

## 2026-08-30 — multilingual + Claude/Codex connections (DONE)
- `language` field on invoice/proforma creation (RO default; EN/FR/etc. must be configured in SmartBill account) + `translatedName`/`translatedMeasuringUnit` per product for non-Romanian docs. Committed `946a91d`, deployed (version 1cda20ef).
- README: Claude Desktop/Codex connection guides (mcp-remote bridge + OAuth), multilingual section, skill language guidance. Committed `eeb3207`.
- 29 tools live. 84/84 tests, tsc clean. Chat language is client-side (any language works — the MCP is language-agnostic).

## 2026-08-30 — conversational E2E (PASS + 1 real bug found/fixed)
Full conversational flow E2E via live MCP (TEST client, cleaned after): draft → gate-check (no confirm = hard error) → finalize SR/0034 → status → PDF (32KB) → payment gate + record → status follow-up → count_totals → search → storno. **Found + fixed: `paymentstatus` wire field is `paid` (not `isPaid`) — the self-heal and status answers read `undefined` before. Live-verified after fix: "ledger=paid | paid=true".** Committed `31be6b1`, deployed (version 0e30a5c3). Tests 84/84, tsc clean. Ledger + SmartBill cleaned (SR nextNumber 36, SRP 1).
