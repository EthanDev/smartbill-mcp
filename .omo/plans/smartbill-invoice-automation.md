# smartbill-invoice-automation - Work Plan

## TL;DR (For humans)

**What you'll get:** A Cloudflare-hosted "invoice engine" — a private MCP (Model Context Protocol) server on Cloudflare Workers that talks to SmartBill, and a Mac Mini Hermes instance connected to it. You WhatsApp/Telegram Hermes: "create invoice for X" → it drafts in SmartBill → you say yes in chat → it issues, emails, records payment, answers questions about any invoice it made. Anyone you invite can authenticate to the MCP with their own GitHub account and connect their own SmartBill account.

**Why this approach:** Your SmartBill credentials live in Cloudflare (encrypted), not in a local .env that could leak — and the invoice engine becomes an MCP that any client (Hermes, other agents, future apps) can authenticate against. Committal actions need YOUR chat-level yes AND a machine-checkable `confirm:true` — a misrouted call alone can never send an invoice.

**What it will NOT do:** No SMS/WhatsApp invoice sending (SmartBill is email-only), no webhooks, no sync of invoices made in the SmartBill website, no sending without your approval, no changes to your existing expense pipeline.

**Effort:** Large
**Risk:** Medium - live SmartBill production tests (no sandbox exists); a token was shared in chat so a rotate-after-deploy step is included
**Decisions to sanity-check:** GitHub OAuth is the MCP's identity layer (invite-only); single company seed (VOICEVUI SRL); CIF format `RO47247261` verified live during smoke, fallback `47247261`.

Your next move: hand this file to the Mac Mini Hermes instance and run it. Human steps it cannot do are marked HUMAN — you'll need: wrangler login (browser), a GitHub OAuth App, Telegram BotFather token, WhatsApp Meta panel steps.

---

> TL;DR (machine): Large effort. Private GitHub repo `smartbill-mcp` -> Cloudflare Workers MCP server (createMcpHandler, stateless, GitHub-OAuth via workers-oauth-provider, D1 ledger, SmartBill V1+V3 client) -> deployed to workers.dev -> Mac Mini Hermes connects as headless MCP client (mcp-remote --header Bearer) -> Telegram + WhatsApp channels -> approval-gated invoice ops + per-user Q&A. Tests: vitest + MCP Inspector + live smoke.

## Scope
### Must have
- Private GitHub repo `smartbill-mcp` (TypeScript, npm, wrangler) containing the Worker MCP server.
- Cloudflare Worker MCP server built with **stateless `createMcpHandler`** + `@modelcontextprotocol/server@2.0.0` + zod (NOT the deprecated McpAgent path). Entry mounted at `/mcp`.
- Authentication: **workers-oauth-provider** GitHub-OAuth flow — `/register`, `/authorize` (consent dialog, CSRF cookies), `/callback` (GitHub code exchange, fetch user), `/token` issuing the MCP access token bound to user `props` (login/email). `OAUTH_KV` KV namespace for state. Per-user identity from `props`/`authInfo`.
- D1 database `smartbill-ledger`: `tenants` (user_id → encrypted SmartBill email/token/CIF, AES-GCM keyed by a Cloudflare secret), `invoices` (series, number, type, status lifecycle, client, totals, currency, pdf_path, user_id, created/updated), `audit_events` (per-invoice event trail: drafted/confirmed/sent/paid/cancelled/storno). Every query scoped by the authenticated user_id.
- SmartBill core client (TS, fetch): V1 Basic Auth (email+token) lifecycle — create (`POST /invoice/v2`), PDF (`GET /invoice/pdf` with `Accept: */*`), email-send (`POST /document/send`), payment status (`GET /invoice/paymentstatus`), record payment (`POST /payment`), cancel/restore (`PUT /invoice/cancel|restore`), storno (`POST /invoice/reverse`), series (`GET /series`), tax (`GET /tax`); V3 Bearer reads — clients/products lists. 429 backoff per Retry-After penalty ladder (5,10,20,40,80,160,300,600s), max 5 retries.
- MCP tools (zod-validated): `create_draft`, `finalize_invoice` (requires `confirm:true` + series/number echo), `send_invoice` (confirm, + to/cc/subject), `record_payment` (confirm, payment type enum), `cancel_invoice` (confirm), `storno` (confirm), `invoice_status`, `get_pdf`, `list_series`, `list_tax`, `search_invoices` (client/status/date-range/text), `list_clients`, `list_products`, `register_account` (a user binds their own SmartBill creds, encrypted).
- Seed tenant: user (Ethan) bound to `ethan1709@protonmail.com` / token `=== TOKEN SUPPLIED BY OWNER OUT-OF-BAND - ASK USER AT RUNTIME ===` / CIF `RO47247261` — stored ONLY in `.dev.vars` (local) and `wrangler secret put` or D1-encrypted (prod). Never in git. CIF verified live; fallback bare `47247261`. CRITICAL: The SmartBill V1 token is NOT in this plan — the owner supplies it directly to the executor at execution time (ask for it when you reach the .dev.vars / secret-put steps). Ask, never assume.
- Deploy to workers.dev; verification via MCP Inspector + live smoke (read-only: series + tax).
- Hermes on the Mac Mini: remote MCP client config (`mcp_servers` entry using mcp-remote with `Authorization: Bearer` token; token issued to the user's own OAuth identity), `accounting/invoicing` skill (chat intents + approval gate + Q&A references) at `~/.hermes/skills/accounting/invoicing/`.
- Channels: Telegram (BotFather token + DM pairing `hermes pairing approve telegram <CODE>` + allowlist) and WhatsApp Cloud (`hermes whatsapp-cloud` wizard + cloudflared tunnel to webhook port 8090).
- Approval gate: committal actions require (a) unambiguous chat "yes" from the paired user after an echo of client/series/number/amount/recipient, AND (b) `confirm:true` passed to the MCP tool. Anything else ("yeah", emoji, silence) is NOT a yes.
- Token rotation step after deploy (credential was shared in plaintext).

### Must NOT have (guardrails, anti-slop, scope boundaries)
- No SmartBill credentials in git, logs, chat, or the MCP tool output. Secrets only in `.dev.vars`, `wrangler secret`, or AES-GCM-encrypted D1 rows.
- No SMS/WhatsApp invoice sending; no webhooks; no polling SmartBill for external changes; no importing manually-created invoices.
- No auto-approval; no bypass of `confirm:true` or the chat gate; no "trust anyone" default (OAuth-issued identities only, invite/approval flow for tenants).
- No McpAgent/Durable Object MCP path (deprecated); no third-party SmartBill SDK; no `smartbill-rest-sdk`.
- No cross-tenant data access — every D1 query and SmartBill call pinned to the authenticated user's tenant.
- No changes to `~/Documents/Claude/Projects/Accounting/accounting_automation/` or any local Python pipeline; don't touch Google Sheets/Drive.
- No logging of Authorization headers or access tokens; no `print`/console.log of credentials.
- Type safety: no `any`, no `as` type assertions without justification; zod = single validation source.

## Verification strategy
> Zero human intervention - all verification is agent-executed except the two HUMAN-marked steps.
- Test decision: vitest for the MCP server (mocked fetch for SmartBill, in-memory D1 via `--remote`/miniflare binding or mocked `env.DB`), zod schema tests for tools. Live smoke (`list_series`, `list_tax`) hits real production read-only. QA invoices are drafts + storno of a TEST client only.
- Evidence: `<workdir>/.omo/evidence/task-N-*.log` per todo; attempt dir under `.omo/evidence/ulw/` if used; final wave under `.omo/evidence/smartbill-invoice-automation/`. WORKDIR on the Mac Mini = `~/smartbill-mcp` (repo clone).
- Local dev: `wrangler dev` uses `.dev.vars` (SmartBill creds + OAUTH secrets); `wrangler d1 migrations apply smartbill-ledger --local`; MCP Inspector against `http://localhost:8788/mcp`.

## Execution strategy
### Parallel execution waves
- Wave 1 (infra, parallel 1-3): repo + wrangler scaffolding; D1+KV+migrations; SmartBill core client (TS, tested).
- Wave 2 (server core, parallel 4-6): auth handler (GitHub OAuth); MCP server + tools (committal confirm-gate); D1 ledger module + per-user scoping.
- Wave 3 (parallel 7-8): deployment config + secrets + OAuth app secrets; local end-to-end (Inspector, mocked SmartBill + live read-only smoke).
- Wave 4 (Hermes side, parallel 9-10): Hermes MCP client config; accounting/invoicing skill (gate + Q&A).
- Wave 5 (channels, parallel 11-12): Telegram; WhatsApp Cloud.
- Wave 6 (13): E2E draft→finalize→storno QA + token rotation; then final wave F1-F4.

### Dependency matrix
| Todo | Depends on | Blocks | Can parallelize with |
| --- | --- | --- | --- |
| 1. Repo + scaffold | — | 2-13 | — |
| 2. D1 + KV + migrations | 1 | 5,6 | 3 |
| 3. SmartBill core (TS) | 1 | 5,6,8 | 2 |
| 4. Auth (GitHub OAuth) | 1 | 6,7 | 2,3 |
| 5. MCP server + tools | 2,3 | 8,13 | 6 |
| 6. D1 ledger + scoping | 2,3,4 | 8,13 | 5 |
| 7. Deploy + secrets + apps | 1 | 8-13 | 5,6 |
| 8. Local E2E + smoke | 5,6,7 | 13 | 9,10 |
| 9. Hermes MCP client | 7 | 13 | 10,11,12 |
| 10. Hermes skill | 8 | 13 | 9 |
| 11. Telegram | 9,10 | 13 | 12 |
| 12. WhatsApp Cloud | 9,10 | 13 | 11 |
| 13. E2E QA + rotation | 5-12 | 14 | — |
| 14. Final wave | 13 | — | — |

## Todos
> Implementation + Test = ONE todo. Never separate.
<!-- APPEND TASK BATCHES BELOW THIS LINE - never rewrite the headers above. -->

### Wave 1 - Infrastructure (parallel: todos 1-3)

- [ ] 1. Private repo + wrangler scaffolding
  What to do / Must NOT do: The private repo ALREADY EXISTS (created by the coordinator: https://github.com/EthanDev/smartbill-mcp, contains this plan at .omo/plans/smartbill-invoice-automation.md). On the Mac Mini: `git clone https://github.com/EthanDev/smartbill-mcp.git ~/smartbill-mcp && cd ~/smartbill-mcp` (HUMAN: gh or git must be authenticated — for gh, `gh auth login`; the repo is private so plain `git clone` needs a PAT, prefer `gh repo clone EthanDev/smartbill-mcp ~/smartbill-mcp`). Scaffold TypeScript worker: `npm create cloudflare@latest . -- --template=cloudflare/ai/demos/remote-mcp-github-oauth` (or `npm create cloudflare@latest smartbill-mcp -- --template=...` and move files in); verify package.json has `agents`, `@modelcontextprotocol/server@2.0.0`, `zod`, devDeps `wrangler`, `vitest`, `typescript`. Create `wrangler.jsonc` (name `smartbill-mcp`, `main: src/index.ts`, `compat_date` current, `kv_namespaces: [{binding: OAUTH_KV, id: <placeholder>}]`, `d1_databases: [{binding: DB, database_name: smartbill-ledger, database_id: <placeholder>}]`, `services` if using templates). `.gitignore` must include `.dev.vars`, `.env`, `node_modules`, `.wrangler`. Create `.dev.vars.example` (names only) and `.dev.vars` (real values, gitignored): SMARTBILL_EMAIL=ethan1709@protonmail.com, SMARTBILL_TOKEN=<ASK USER - owner supplies the V1 token at runtime>, SMARTBILL_CIF=RO47247261, SMARTBILL_CIF_FALLBACK=47247261, GITHUB_CLIENT_ID=, GITHUB_CLIENT_SECRET=, COOKIE_ENCRYPTION_KEY=, ENCRYPTION_KEY=. Do NOT commit .dev.vars. Do NOT paste credentials into any tracked file. The token is deliberately NOT in this plan: when you reach the .dev.vars step, ask the user for the SMARTBILL_TOKEN value and write it into the gitignored file.
  Parallelization: Wave 1 | Blocked by: — | Blocks: 2-13
  References: template `cloudflare/ai/demos/remote-mcp-github-oauth` (canonical OAuth MCP example); current docs base https://developers.cloudflare.com/agents/model-context-protocol/ (McpAgent deprecated — use createMcpHandler; template wrangler compat_date 2025-03-10, mcp-worker example updated 2026-06-11). Creds from user: ethan1709@protonmail.com / token = ASK USER (kept out of repo on purpose) / CIF RO47247261 (fallback 47247261).
  Acceptance criteria (agent-executable): `gh repo view smartbill-mcp --json private` shows private:true; `npx wrangler --version` exits 0; `grep -c "SMARTBILL_EMAIL" .dev.vars` == 1; `git status --porcelain` shows .dev.vars ignored (absent from status).
  QA scenarios: happy = commands above. Failure = gh not authed -> `gh auth status` and report; npm template install fails -> fall back to `npm i -D wrangler typescript vitest && npm i agents @modelcontextprotocol/server@2.0.0 zod`. Evidence `~/smartbill-mcp/.omo/evidence/task-1-*.log`
  Commit: Y | chore: scaffold smartbill-mcp worker (private repo, wrangler, gitignored secrets)

- [ ] 2. D1 schema + KV namespace + migrations
  What to do / Must NOT do: `npx wrangler d1 create smartbill-ledger` and `npx wrangler kv namespace create OAUTH_KV`; copy returned IDs into wrangler.jsonc (database_id, kv id). Create `migrations/0001_initial.sql`: `tenants(id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL, smartbill_email TEXT NOT NULL, token_enc BLOB NOT NULL, token_iv BLOB NOT NULL, cif TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now')))`; `invoices(user_id TEXT NOT NULL, series TEXT NOT NULL, number TEXT, doc_type TEXT DEFAULT 'factura', status TEXT CHECK(status IN ('draft','issued','sent','paid','cancelled','storno')), client_name TEXT, client_cif TEXT, issue_date TEXT, due_date TEXT, total_ron REAL, currency TEXT DEFAULT 'RON', pdf_path TEXT, created_at TEXT, updated_at TEXT, PRIMARY KEY(user_id, series, number), UNIQUE(user_id, series, text_serial))` — keep it simple: use `id INTEGER PRIMARY KEY AUTOINCREMENT, user_id, series, number, ...` and a unique index on (user_id, series, number) where number not null (draft may have null number; use a `draft_id` uuid column). `audit_events(id INTEGER PK, invoice_id INTEGER, user_id TEXT, event TEXT, actor TEXT, at TEXT DEFAULT (datetime('now')))`. Apply locally: `npx wrangler d1 migrations apply smartbill-ledger --local`. Do NOT store plaintext token (only token_enc/token_iv). No ORM — raw sql via env.DB.prepare.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5,6
  References: D1 for cross-request data is the documented pattern ("Store cross-request data behind an authenticated handle in ... D1"); `wrangler d1 migrations apply` / `--local`; D1 binding `env.DB.prepare(...).all/.run`. Statuses map: create isDraft:true->draft, isDraft:false->issued, send->sent, payment->paid, cancel->cancelled, reverse->storno.
  Acceptance criteria (agent-executable): `npx wrangler d1 migrations apply smartbill-ledger --local` exits 0 twice (second = no-op); sqlite3 `.schema` contains tenants/invoices/audit_events (or `wrangler d1 execute smartbill-ledger --local --command "SELECT name FROM sqlite_master"` lists 3 tables).
  QA scenarios: happy = migrations apply clean. Failure = duplicate migration -> check `migrations/` naming and `d1 migrations list`. Evidence `~/smartbill-mcp/.omo/evidence/task-2-*.log`
  Commit: Y | feat(db): D1 schema (tenants, invoices, audit_events) + OAUTH_KV

- [ ] 3. SmartBill core client (TypeScript)
  What to do / Must NOT do: Create `src/smartbill/client.ts`: `V1Client` (options: email, token, cif; `base = https://ws.smartbill.ro/SBORO/api`; `Authorization: Basic base64(email:token)`) with methods createInvoice(body), getPdf(cif, seriesname, number) — MUST send `Accept: */*` (application/pdf -> 406), sendDocument(body) (returns {code, message} — code!=0 => throw), paymentStatus(cif, seriesname, number), recordPayment(body), cancelInvoice(cif, seriesname, number), restoreInvoice(...), storno(body), listSeries(cif, type?), listTax(cif). `src/smartbill/v3.ts`: `V3Client` (Bearer; base `https://ws.smartbill.ro/SBORO/api/v3`, path `/v3/companies/{cif}/clients` per spec — verify against downloaded `specs/smartbill-api-spec.yaml` and use the spec's servers+paths if they conflict) listClients(cif, name?, limit), listProducts(cif, name?, code?, limit). `src/smartbill/errors.ts`: SmartBillError (status, rawBody, errorText), SmartBillAuthError(401), SmartBillRateLimit(429, retryAfter), SmartBillValidation(400/406), SmartBillServerError(5xx). `src/smartbill/ratelimit.ts`: backoff ladder [5,10,20,40,80,160,300,600]s with maxRetries 5, honoring Retry-After. Download the spec: `curl -o specs/smartbill-api-spec.yaml https://api.smartbill.ro/smartbill-api-spec.yaml` (x-last-updated 2026-08-21) and READ it for exact paths. Take payload field names from the spec (InvoiceRequest/ClientRef/ProductLine: companyVatCode, seriesName, issueDate, client{name, country, vatCode?, regCom?, isTaxPayer?, email?, address?, city?}, products[{name, code, quantity, measuringUnitName, taxPercentage, price}], isDraft, dueDate, currency, useIntraCif...). VAT: since 2025-08-01 Romania 19->21%, 5->11% — use taxPercentage provided per product; do NOT compute tax. Write vitest unit tests with mock fetch asserting: Basic header, exact paths/verbs/params, Accept */* on pdf, error mapping 401/429/406/502, backoff on 429.
  Must NOT: use application/pdf Accept; third-party SDKs; put creds in tests (inject); guess paths where the spec is downloadable.
  Parallelization: Wave 1 | Blocked by: 1 | Blocks: 5,6,8
  References: spec paths verified: /invoice/v2, /invoice/pdf(2400), /document/send(5716), /invoice/paymentstatus(2468), /payment(4809), /invoice/cancel(2597), /invoice/restore(2720), /invoice/reverse(2170), /series(5440), /tax(5382), V3 under 6305-7334 (clients 6559/6745, products 7078/7234). V1 30 calls/10s then 10-min block; V3 reads 60/10s, daily 50k midnight Bucharest. Payment types: Chitanta, Card, OrdinPlata, CEC, BiletOrdin, MandatPostal, BonFiscal, AltaIncasare.
  Acceptance criteria (agent-executable): `npx vitest run` passes; mock asserts Basic header `Basic base64("email:token")`; a test pins `Accept` on getPdf to not be application/pdf.
  QA scenarios: happy = unit green. Failure = mock 502 HTML on pdf -> SmartBillServerError with rawBody. Evidence `~/smartbill-mcp/.omo/evidence/task-3-*.log`
  Commit: Y | feat(smb): SmartBill V1 lifecycle + V3 read clients, typed errors, 429 backoff

### Wave 2 - Server core (parallel: todos 4-6)

- [ ] 4. Auth handler (GitHub OAuth via workers-oauth-provider)
  What to do / Must NOT do: Implement the OAuth flow from the canonical example: `src/auth/github-handler.ts` (parseAuthRequest, CSRF-protected consent dialog with `__Host-CSRF_TOKEN` cookie, state in OAUTH_KV + `__Host-CONSENTED_STATE` cookie, redirect to GitHub, /callback exchanges code (fetchUpstreamAuthToken), fetches user info, then `OAUTH_PROVIDER.completeAuthorization({ props: {login, email, name}, userId: login, scope, metadata })`); `src/auth/provider.ts` (OAuthProvider with client_id/secret from env/secrets, encrypted state with COOKIE_ENCRYPTION_KEY); route wiring: /.well-known/oauth-authorization-server, /register, /authorize, /callback, /token, and /mcp protected by the provider. Store user identity: on first authed tool call, ensure a tenants row exists (user_id = login; SmartBill creds seeded for the owner from env vars — see todo 6). HUMAN: create a GitHub OAuth App (Settings->Developer settings->OAuth Apps) with callback URL `https://<worker>.workers.dev/callback`; get client_id/secret; put into `.dev.vars` (local) and `wrangler secret put GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `COOKIE_ENCRYPTION_KEY` (openssl rand -hex 32) for prod. Write vitest for parse/authorize redirect + consent CSRF (mock upstream). Do NOT ship client_secret in worker code or tests.
  Must NOT: roll your own token service; skip consent; store GitHub access token in D1 (props carry it per-request only; do not log it).
  Parallelization: Wave 2 | Blocked by: 1 | Blocks: 6,7
  References: workers-oauth-provider OAuthProvider pattern (unchanged/current); template github-handler.ts: `import { env } from "cloudflare:workers"` gives typed bindings anywhere; authInfo via getMcpAuthContext() / context.http?.authInfo?.clientId in stateless createMcpHandler; OAUTH_KV REQUIRED for state. Current docs: https://developers.cloudflare.com/agents/model-context-protocol/guides/remote-mcp-server/#add-authentication
  Acceptance criteria (agent-executable): `npx vitest run src/auth` green; `npx wrangler dev` local + `curl -sI http://localhost:8788/mcp` returns 401 with WWW-Authenticate; `.dev.vars` has GITHUB_CLIENT_ID (value present — mask in evidence).
  QA scenarios: happy = unauthenticated /mcp -> 401 challenge. Failure = misconfigured client_id -> 500 at /authorize; fix .dev.vars values. Evidence `~/smartbill-mcp/.omo/evidence/task-4-*.log`
  Commit: Y | feat(auth): GitHub-OAuth MCP auth (consent, callback, provider bindings)

- [ ] 5. MCP server + tools
  What to do / Must NOT do: Create `src/index.ts` (entry; `createMcpHandler(factory, { route: '/mcp' })` + stateless server via `@modelcontextprotocol/server`; also handle `/health` returning 200). Tools in `src/tools/*.ts` with zod schemas (zod = single validation source):
  - create_draft({client, products, series?, issueDate?, currency?, dueDate?}) -> isDraft:true, ledger row status draft.
  - finalize_invoice({draft_id | series, number, confirm: z.literal(true)}) — throws if confirm !== true.
  - send_invoice({series, number, to?, cc?, subject?, bodyText?, confirm: z.literal(true)}).
  - record_payment({series, number, type, value, currency?, confirm: z.literal(true)}).
  - cancel_invoice / storno ({series, number, confirm: z.literal(true)}).
  - invoice_status({series, number}) -> ledger + live paymentstatus.
  - get_pdf({series, number}) -> returns pdf base64/mime (embed as image/pdf content).
  - list_series({type?}), list_tax({}) (V1 reads), list_clients({name?, limit?}), list_products({name?, code?, limit?}) (V3 reads).
  - search_invoices({client?, status?, from?, to?, text?}) -> D1 search.
  - register_account({email, token, cif}) — encrypts and stores the authenticating user's own SmartBill creds (owner-only seed uses env; this lets invited users bind their own company).
  Every tool resolves the tenant: `getTenantForAuthUser(authInfo)` -> decrypt creds -> client. Tool responses: text content, no secrets. Return types: `{content:[{type:"text", text: ...}]}`. Never expose token/email in response text.
  Must NOT: implement tools without confirm gate; bypass zod; read another tenant's rows; include raw creds in output; use McpAgent.
  Parallelization: Wave 2 | Blocked by: 2,3 | Blocks: 8,13
  References: createMcpHandler (agents/mcp/server), McpRequestContext {era, authInfo?, requestInfo?}, keepAliveMs 15s, stateless factory per-request (no global instance); legacy SSE via createLegacyMcpHandler only if a client needs it — default streamable HTTP POST /mcp; tool timeouts 30s default CPU. `@modelcontextprotocol/server@2.0.0` + zod.
  Acceptance criteria (agent-executable): `npx vitest run src/tools` green — test that finalize/send/payment/cancel/storno THROW on missing confirm:true, and succeed with it; `curl http://localhost:8788/health` 200.
  QA scenarios: happy = tool call with confirm:true proceeds. Failure = call without confirm -> typed error "confirm:true required". Evidence `~/smartbill-mcp/.omo/evidence/task-5-*.log`
  Commit: Y | feat(mcp): invoice lifecycle tools with confirm gate + tenant resolution

- [ ] 6. D1 ledger module + per-user scoping + secret encryption
  What to do / Must NOT do: `src/ledger/ledger.ts`: encryptOrchestra — AES-GCM (node:crypto/webcrypto) encrypt/decrypt SmartBill token with ENCRYPTION_KEY secret; `ensureTenant(userId)` (owner: user_id='owner<login>'? Use login as user_id and detect owner via env OWNER_GITHUB_LOGIN — seed owner tenant from SMARTBILL_* env on first run); `createInvoice(userId, record)` (status draft/issued per isDraft; draft gets a uuid `draft_id`); `setStatus(userId, series, number, status, actor)` + audit row; `search(userId, filters)` (parameterized only); `countTotals(userId, month?, client?)` for Q&A. `src/ledger/tenant.ts`: getTenantForAuthUser(authInfo) -> {email, token, cif} decrypted. All SQL parameterized — never f-string user input. Seed: on first authenticated call by the OWNER with no tenants row, create tenant from env (SMARTBILL_EMAIL/TOKEN/CIF) — encrypt token at rest. Register `register_account` storage path into this module. Write vitest with a mocked env.DB (or miniflare binding) covering: owner seeding, unauthorized tenant read rejection, status transition audit rows, search scoping (user A cannot see user B rows).
  Must NOT: store plaintext token; use ORM; allow unscoped queries; log decrypted token.
  Parallelization: Wave 2 | Blocked by: 2,3,4 | Blocks: 8,13
  References: crypto AES-GCM with key from env secret ENCRYPTION_KEY (openssl rand -hex 32 -> 256-bit key); D1 binds via `env.DB`; `cloudflare:workers` env import for stateless handlers.
  Acceptance criteria (agent-executable): `npx vitest run src/ledger` green incl. cross-tenant rejection test; `grep -rn "token" src/ledger/` shows no plaintext assignment (only token_enc/iv).
  QA scenarios: happy = owner seeds, creates invoice, audit row exists. Failure = user B queries user A => error/empty. Evidence `~/smartbill-mcp/.omo/evidence/task-6-*.log`
  Commit: Y | feat(ledger): D1 tenant + invoice store, AES-GCM token encryption, per-user scoping

### Wave 3 - Deploy + local E2E (parallel: todos 7-8)

- [ ] 7. Production secrets + OAuth app config + deploy
  What to do / Must NOT do: HUMAN steps (browser): create GitHub OAuth App (or reuse from todo 4) with callback URL; get token via `https://cloud.smartbill.ro/core/integrari/` if a V3 token is needed (V1 token already provided - V3 is optional/deferred). Then agent: `npx wrangler secret put SMARTBILL_EMAIL`, `SMARTBILL_TOKEN`, `SMARTBILL_CIF` (value RO47247261), `SMARTBILL_CIF_FALLBACK` (47247261), `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `COOKIE_ENCRYPTION_KEY` (openssl rand -hex 32), `ENCRYPTION_KEY` (openssl rand -hex 32), `OWNER_GITHUB_LOGIN`. Migrate prod D1: `npx wrangler d1 migrations apply smartbill-ledger --remote`. Deploy: `npx wrangler deploy`. Verify: `curl -sI https://smartbill-mcp.<account>.workers.dev/mcp` 401 + WWW-Authenticate; `curl -s https://smartbill-mcp.<account>.workers.dev/health` 200; `npx wrangler deployments list` shows the deployment; `npx wrangler tail` one request then stop. Do NOT put secrets in wrangler.jsonc; do NOT print secret values.
  Parallelization: Wave 3 | Blocked by: 5,6 (secrets only need 4) | Blocks: 8-13
  References: `npx wrangler secret put <NAME>` (typed input, no echo); `.dev.vars` for local only; D1 remote migrations; workers.dev URL = https://<name>.<account>.workers.dev/mcp; __Host- cookie prefix caveat on workers.dev subdomains.
  Acceptance criteria (agent-executable): curl /health 200, /mcp 401; `npx wrangler d1 migrations list smartbill-ledger --remote` shows 0001 applied.
  QA scenarios: happy = deployed + health ok. Failure = 500 on /mcp -> `wrangler tail` to see error, fix, redeploy. Evidence `~/smartbill-mcp/.omo/evidence/task-7-*.log`
  Commit: Y | chore(deploy): prod secrets, D1 remote migrate, first deployment

- [ ] 8. Local end-to-end (MCP Inspector + mocked/live smoke)
  What to do / Must NOT do: Local: `npx wrangler dev` (uses .dev.vars) + `npx @modelcontextprotocol/inspector@latest` -> http://localhost:5173, enter http://localhost:8788/mcp; with OAuth "Quick flow", sign in with the HUMAN's GitHub account -> list tools; run `list_series` and `list_tax` LIVE (read-only, production, safe): confirm output has the factura series and ≤5 tax rows; if CIF RO47247261 is rejected (401/validation), retry with fallback 47247261 and record which form works BOTH in D1 cif column and in the plan-notes. Run mocked-draft scenario: create_draft via Inspector for a "TEST" client (one product line, 21% tax, price 10) — do NOT finalize yet (final QA in todo 13). Attach screenshots/receipts as evidence. Do NOT send emails, record payments, or finalize in this todo. Do NOT create more than one document; delete draft ledger row after.
  Must NOT: run any committal op here; use real clients; leave stray drafts (storno/clean in todo 13 instead).
  Parallelization: Wave 3 | Blocked by: 5,6,7 | Blocks: 10,13
  References: MCP Inspector is the local-client verification; streamable HTTP; live smoke is the ONLY prod read (list_series/list_tax); CIF variants from source machine companies.json.
  Acceptance criteria (agent-executable): Inspector lists all 14 tools; list_series returns series (exit ok); no errorText; evidence log captures the smoke output with NO token values.
  QA scenarios: happy = tools listed + series fetched. Failure = auth issue in Inspector -> complete OAuth again; tool error -> read tool response errorText, fix server, restart `wrangler dev`. Evidence `~/smartbill-mcp/.omo/evidence/task-8-*.log`
  Commit: N (no code change unless bug found -> fix + test + commit)

### Wave 4 - Hermes side (parallel: todos 9-10)

- [ ] 9. Hermes MCP client config + owner token
  What to do / Must NOT do: On the Mac Mini: obtain an MCP bearer token for the OWNER by completing the OAuth flow once (mcp-remote interactive or the token endpoint with a device-ish flow — human step) — OR, if simpler for a headless client, issue via `npx mcp-remote https://smartbill-mcp.<account>.workers.dev/mcp --header "Authorization: Bearer <TOKEN>"` interactively once to capture the token into a local file `~/.hermes/.secrets/smartbill-mcp-token` (chmod 600). Then in `~/.hermes/config.yaml` add to `mcp_servers`: `smartbill-mcp: { command: npx, args: ["mcp-remote", "https://smartbill-mcp.<account>.workers.dev/mcp", "--header", "Authorization: Bearer <TOKEN>"] }`. IMPORTANT: check the hermes-agent MCP client source (`hermes-agent/` in ~/.hermes) for the config schema — if Hermes supports `url`-style remote MCP with headers config, prefer that; if only stdio command form, use mcp-remote. After config: `hermes` restart and verify the server connects (`hermes doctor` or a `hermes` chat prompt asking to list tools). Do NOT put the token literal in config.yaml if the client supports env interpolation; use ${SMARTBILL_MCP_TOKEN} + .env export otherwise. Never log the token.
  Must NOT: commit token; use a token that isn't scoped to owner; add the server to global config with wrong auth.
  Parallelization: Wave 4 | Blocked by: 7 | Blocks: 11,12,13
  References: mcp-remote v0.8.1 supports `--header "Authorization: Bearer ${TOKEN}"` for headless; Cloudflare Access service token alternative (CF-Access-Client-Id/Secret headers); Hermes config.yaml already has mcp_servers (Cloudflare, Linear, Sentry) on the source machine — mirror the format; Hermes platform env-driven config (`github.config` etc.).
  Acceptance criteria (agent-executable): `grep -c "smartbill-mcp" ~/.hermes/config.yaml` >= 1; token file exists with `stat -f%Lp` == 600; Hermes chat listing shows the MCP server tools (evidence line).
  QA scenarios: happy = server tools listed in Hermes. Failure = connect error -> check URL/token; wrong header format -> `--header` vs `--header "Authorization: ..."`. Evidence `~/smartbill-mcp/.omo/evidence/task-9-*.log`
  Commit: N (local config, not in repo) — document exact config snippet in annotations.

- [ ] 10. Hermes accounting/invoicing skill (gate + Q&A)
  What to do / Must NOT do: Create `~/.hermes/skills/accounting/invoicing/SKILL.md` (frontmatter name/description/triggers following the existing format, e.g. `~/.hermes/skills/productivity/accounting-automation/SKILL.md` style) + `references/approval-gate.md` + `references/qa.md` + `references/mcp-usage.md`. Skill content: chat intents map to MCP tools: "create invoice for <client>" -> create_draft; "confirm/send it" -> gate; "send invoice" -> ask to/cc + gate; "record payment" -> gate; "status of X" -> invoice_status; "pdf" -> get_pdf; "what's unpaid for Y" / "totals this month" -> search_invoices/countTotals; "find invoice 123" -> search_invoices. approval-gate.md: the agent MUST ask a yes/no question in chat + echo summary (client, series, number, amount, recipient), then call tool with confirm:true ONLY after an unambiguous explicit "yes" from the paired user; anything else ("yeah", "ok", emojis, silence) is NOT a yes; "no" cancels; also document that 'confirm' means finalize = create non-draft (SmartBill has no confirm endpoint). qa.md: patterns scoped to this-agent invoices only; enrich with live paymentstatus + PDFs. mcp-usage.md: exact tool calling conventions + that search uses D1.
  Must NOT: allow self-confirmation; add overlapping triggers with existing skills; hardcode tokens.
  Parallelization: Wave 4 | Blocked by: 8 | Blocks: 11,12,13
  References: Hermes skills discovered by filesystem placement (~/.hermes/skills/<category>/<name>/SKILL.md), no registration; `hermes skills list` to verify; refs from earlier inventory: productivity/accounting-automation format.
  Acceptance criteria (agent-executable): `hermes skills list 2>&1 | grep -i invoicing` shows the skill; `grep -c "confirm:true" references/approval-gate.md` >= 1; grep shows gate text per committal action.
  QA scenarios: happy = skill visible + gate documented. Failure = skill not surfaced -> check frontmatter name/category. Evidence `~/smartbill-mcp/.omo/evidence/task-10-*.log`
  Commit: N (lives in ~/.hermes) — include a copy under repo `hermes/` for versioning, committed.

### Wave 5 - Channels (parallel: todos 11-12)

- [ ] 11. Telegram: bot token + DM pairing + allowlist
  What to do / Must NOT do: HUMAN: create bot via @BotFather (or reuse existing token); get token. Agent: append `TELEGRAM_BOT_TOKEN=<token>` (+ `TELEGRAM_ALLOWED_USERS=<owner_user_id>` and `TELEGRAM_ALLOW_ALL_USERS=false`) to `~/.hermes/.env`; reload gateway (`hermes gateway restart` if installed, else `hermes gateway install --start-now` / `hermes gateway run --replace` for dev). Pair: owner DMs the bot; gateway generates code in `~/.hermes/pairing/`; run `hermes pairing list` then `hermes pairing approve telegram <CODE>`. Verify: `hermes gateway status --deep` shows telegram connected; send "ping" from Telegram -> reply. Do NOT set TELEGRAM_ALLOW_ALL_USERS=true; do NOT copy the source machine's config.yaml wholesale.
  Parallelization: Wave 5 | Blocked by: 9,10 | Blocks: 13
  References: TELEGRAM_BOT_TOKEN required (plugins/platforms/telegram/plugin.yaml + gateway/config.py 1836-1839); env-driven enablement; pairing: `hermes pairing list/approve telegram <CODE>/revoke/clear-pending` (codes auto-generated on unauthorized DM, stored ~/.hermes/pairing/).
  Acceptance criteria (agent-executable): `grep -c "^TELEGRAM_BOT_TOKEN=" ~/.hermes/.env` == 1; `hermes pairing list` shows approved; ping reply logged.
  QA scenarios: happy = ping round-trip. Failure = pairing code expired -> revoke + re-DM + approve once; 401 -> wrong token from BotFather. Evidence `~/smartbill-mcp/.omo/evidence/task-11-*.log`
  Commit: N

- [ ] 12. WhatsApp Cloud: wizard + webhook tunnel
  What to do / Must NOT do: Agent: run `hermes whatsapp-cloud` (interactive wizard; writes ~/.hermes/.env) — HUMAN steps it prints: Meta developer account -> create app -> WhatsApp product/WABA -> test or production number -> token (24h temp OK for QA; System User permanent for prod) -> App Secret/App ID -> configure webhook callback `https://<tunnel>/whatsapp/webhook` + verify token -> subscribe `messages` -> add recipient phone; then `cloudflared tunnel --url http://localhost:8090` (background; record URL). Set WHATSAPP_CLOUD_ALLOWED_USERS to the operator phone. Reload gateway; send "ping" from WhatsApp -> reply. Do NOT use the Baileys `hermes whatsapp` bridge; do NOT leave the 24h temp token for production (note in annotations); do NOT expose the webhook without the verify token.
  Parallelization: Wave 5 | Blocked by: 9,10 | Blocks: 13
  References: `hermes whatsapp-cloud` wizard (hermes_cli/setup_whatsapp_cloud.py; prints cloudflared instructions); env vars WHATSAPP_CLOUD_PHONE_NUMBER_ID/ACCESS_TOKEN/VERIFY_TOKEN/WABA_ID/APP_ID/APP_SECRET/WEBHOOK_HOST(0.0.0.0)/PORT(8090)/PATH(/whatsapp/webhook)/ALLOWED_USERS/API_VERSION(default v20.0); cloud enablement driven by PHONE_NUMBER_ID + ACCESS_TOKEN presence (NOT WHATSAPP_ENABLED — that's the Baileys bridge). Webhook verification requires the exact callback URL + verify token.
  Acceptance criteria (agent-executable): `grep -c "WHATSAPP_CLOUD_PHONE_NUMBER_ID" ~/.hermes/.env` == 1; `pgrep -f cloudflared` shows process; `curl -s -o /dev/null -w "%{http_code}" <tunnel>/whatsapp/webhook` == 200; ping reply logged.
  QA scenarios: happy = ping round-trip. Failure = Meta verify fails -> re-tunnel (URL changes) + re-subscribe; 401 from Meta -> token expiry (temp) -> regenerate. Evidence `~/smartbill-mcp/.omo/evidence/task-12-*.log`
  Commit: N

### Wave 6 - E2E QA + rotation (todo 13), then final wave (14)

- [ ] 13. E2E: draft -> chat approval -> finalize -> PDF -> storno, then rotate token
  What to do / Must NOT do: Via Telegram (primary): 1) message "create invoice for TEST CLIENT <date>" -> agent calls create_draft (isDraft:true, one product line 21%, price 10, series from list_series output); 2) ledger row status draft; 3) message "confirm" -> agent MUST ask a yes/no question + echo (client, series, number, amount); 4) user replies "yes" -> finalize_invoice(confirm:true) -> number assigned (record: isDraft docs get no number until finalized — verify + record); 5) `status` -> issued; 6) `pdf` -> file downloads non-empty; 7) message "storno it" -> gate -> storno(confirm:true) -> status storno; 8) `search_invoices --status storno` lists it. NO emails/payments in this todo. Then ROTATE the SmartBill V1 token: HUMAN logs into cloud.smartbill.ro/core/integrari/ -> regenerate token -> agent `wrangler secret put SMARTBILL_TOKEN` + re-encode in D1 tenant row (update token_enc/iv); re-run ONE read (list_series) to confirm the new token works; delete the old token from .dev.vars. Do NOT use a real client; do NOT send email; do NOT exceed 1 invoice + 1 storno; do NOT skip rotation.
  Parallelization: Wave 6 | Blocked by: 5-12 | Blocks: 14
  References: invoice create minimal fields; isDraft no number until finalized (spec 1656-1700); storno = POST /invoice/reverse (one storno per invoice, cannot storno a cancelled invoice); PDF via get_pdf Accept */*; rotation rationale: credential shared in plaintext chat.
  Acceptance criteria (agent-executable): ledger shows QA invoice status storno + pdf non-empty; rotation done in evidence; `list_series` works after rotation with NEW token; no email sent.
  QA scenarios: happy = full loop. Failure = storno errors (e.g. already cancelled) -> record exact errorText, report; do NOT loop. If rotation breaks auth -> restore old token via secret put, report. Evidence `~/smartbill-mcp/.omo/evidence/task-13-*.log`
  Commit: N (live QA; bug -> fix + test + commit)

- [ ] 14. Final verification wave (F1-F4) + annotations
  What to do / Must NOT do: F1 Plan compliance: walk every MUST-have; grep repo for SMS/webhooks/auto-approve absence; confirm confirm:true gates present on all 5 committal tools. F2 Code quality: `npx vitest run --coverage` >= 80%; `npx wrangler deploy --dry-run --outdir dist` builds clean; eslint/tsc `npx tsc --noEmit` clean; secrets-out grep: verify `SMARTBILL_TOKEN` in tracked files contains only the placeholder (never the real token) and no `.dev.vars` is tracked — `git ls-files | grep -E "\.dev\.vars$"` returns nothing; no `any` in src (grep). F3 Real manual QA (HUMAN): user sends ONE real invoice to a known address via chat ("send invoice ... to <own email>") and confirms delivery + PDF content in email. F4 Scope fidelity: `git -C ~/Documents/Claude/Projects/Accounting/accounting_automation status --short` clean; only ~/smartbill-mcp + ~/.hermes/skills/accounting/invoicing + ~/.hermes/config.yaml/.env changed. Write `.omo/annotations/wrap-up.md` for the user: MCP URL, how to connect other clients (token + mcp-remote), how to invite a user (OAuth access), how the gate works, remaining caveats (WhatsApp temp token -> permanent, V3 token optional).
  Must NOT: declare done on any F failure; leave failing tests; commit secrets.
  Parallelization: Wave 6 | Blocked by: 13 | Blocks: —
  References: template F1-F4; evidence `.omo/evidence/smartbill-invoice-automation/`.
  Acceptance criteria (agent-executable): all four F checks logged; coverage >= 80%; tsc/tsc clean; grep for credentials returns zero hits.
  QA scenarios: F2 failure -> add tests for uncovered module, re-run. F3 is user-gated — wait. Evidence `~/smartbill-mcp/.omo/evidence/task-14-*.log`
  Commit: Y | docs: final verification wave + wrap-up annotations

## Final verification wave
> Runs in parallel after ALL todos. ALL must APPROVE. Surface results and wait for the user's explicit okay before declaring complete.
- [ ] F1. Plan compliance audit (Todo 14)
- [ ] F2. Code quality review (Todo 14)
- [ ] F3. Real manual QA - the ONE user-sent real invoice email (Todo 14)
- [ ] F4. Scope fidelity (Todo 14)

## Commit strategy
- Commits in `~/smartbill-mcp` only (private repo). Conventional commits per todo. NEVER commit `.dev.vars`, `.env`, tokens, or the SmartBill credential. `wrangler.jsonc` commits with placeholder IDs.
- Hermes-side assets (skill, config), `~/.hermes/.env` appends, cloudflared — not committed; mirrored into the repo's `hermes/` folder for versioning (skill + config snippets, sanitized).
- No commit until acceptance criteria pass; secret rotation is a post-deploy step, not a commit.

## Success criteria
- From Telegram AND WhatsApp on the Mac Mini: message "create invoice for X" -> SmartBill draft; chat yes + confirm:true -> issued with number; "send" -> email sent after yes; "record the payment" -> after yes; "cancel"/"storno" -> after yes; "status/pdf" -> answered with PDF; "what's unpaid for Y" / "totals this month" -> answered from D1 (this-agent invoices).
- MCP auth: unauthenticated clients get 401 + OAuth flow; authenticated users only see their own tenant; invited users can register their own SmartBill account.
- Gate enforced twice: machine (`confirm:true` via zod) and chat (unambiguous yes). Coverage >= 80%, tsc clean, credentials absent from git, token rotated after deploy, one real email-send user-verified.
- The Mac Mini repo is healthy: `vitest run` green, `wrangler deploy` builds, `wrangler d1 migrations list` shows applied, `hermes skills list` shows the skill.
