# smartbill-mcp

A **conversational invoice engine for SmartBill.ro** — a remote MCP (Model Context Protocol) server on Cloudflare Workers that turns plain chat messages into real invoices. Anyone with a SmartBill account can connect their own company and then create, send, pay, cancel, and ask questions about invoices **entirely through chat** (Telegram, WhatsApp, or any MCP-capable AI tool).

**Live endpoint:** `https://smartbill-mcp.ethan1709.workers.dev/mcp` (OAuth-protected)

---

## 🧍 The end-user experience (layman's terms)

### 1. Get access
Anyone you share the MCP address with can use it. If they use **Hermes**, they add one config entry. If they use another AI tool (Claude Desktop, Cursor, etc.), they paste the same link into its MCP settings. No signups on your side.

### 2. Sign in with GitHub (30 seconds)
The first time their AI tool talks to the MCP, a browser tab opens: **"Sign in with GitHub."** They log in and click **Authorize**. That's their identity — now they can see the tools but haven't connected their company yet.

### 3. Connect their SmartBill account (one time, ~2 minutes)
The first time they ask for anything, the agent asks for three values, all found in **cloud.smartbill.ro → Contul meu → Integrări** (token at the bottom of the page):
- SmartBill **login email**
- **API token**
- **CIF** (company tax ID)

> **2FA? No problem.** SmartBill's two-step authentication only protects web *login* and a few portal actions (IBAN changes, adding users, account info, password reset). The **API token works without any 2FA code** — enabling 2FA never blocks the MCP. Users just enter their 2FA code when logging into the website to reach the Integrări page.

The server **tests the token immediately** with a read-only check, encrypts it at rest (AES-GCM, per-user), and confirms: **"Account connected!"**

### 4. Use it by chatting
From then on it's pure conversation:

| You say | What happens |
|---|---|
| `create invoice for Acme 500 RON` | Agent drafts it → shows summary → you say **yes** → issued |
| `send it` | Emailed to the client (after your yes) |
| `pay 26 1500` + yes | Payment recorded |
| `storno` / `cancel` + yes | Invoice reversed / cancelled |
| `status 26` / `pdf 26` | Status answered / PDF delivered |
| `how many invoices do I have?` | **"You have 23 invoice(s). Breakdown: issued: 10, paid: 7, storno: 6. Sum total: 345 RON."** |
| `what's unpaid for Acme?` | Answered from the ledger |
| `sync` | Imports their Facturi emise Excel export so counts cover their full history |

**Safety rule:** nothing committal (issue, send, pay, cancel, storno) ever happens without an unambiguous **"yes"** in chat — confirmed twice: the chat gate and a machine-checked `confirm:true`.

---

## 🏗 Architecture

```
Telegram / WhatsApp / any MCP client
        │  (natural language)
        ▼
Hermes agent (or other AI tool)  ── chat intents + approval gate
        │  MCP (OAuth 2.1 PKCE)
        ▼
Cloudflare Worker  ── smartbill-mcp.ethan1709.workers.dev/mcp
   ├─ GitHub OAuth (identity) + per-user allowlist / open registration
   ├─ D1 ledger (SQLite): tenants (encrypted creds), invoices, audit_events
   ├─ SmartBill V1 client (Basic Auth) — create/pdf/send/pay/cancel/storno/series/tax
   └─ SmartBill V3 client (Bearer) — clients/products reads (optional)
        │
        ▼
SmartBill.ro API (per-user company)
```

- **Identity:** GitHub OAuth via `workers-oauth-provider` (OAuth 2.1, PKCE, dynamic client registration, token refresh).
- **Tenancy:** one SmartBill account per GitHub user, stored AES-GCM-encrypted in D1. Every query and API call is scoped to the authenticated user — no cross-tenant access.
- **Ledger:** local source of truth for invoice counts/Q&A (SmartBill's API has no invoice-list endpoint — verified against the 2026 OpenAPI spec).

---

## 🔌 How to connect (for developers / Hermes users)

### Hermes (native OAuth — recommended)
Add to `~/.hermes/config.yaml` under `mcp_servers`:

```yaml
  smartbill-mcp:
    url: https://smartbill-mcp.ethan1709.workers.dev/mcp
    auth: oauth
    timeout: 180
```

Then: `hermes mcp login smartbill-mcp` (browser opens once) → `hermes mcp test smartbill-mcp` → 16 tools.

### Any other MCP client
Point it at `https://smartbill-mcp.ethan1709.workers.dev/mcp` and complete the OAuth flow in the browser.

### First-use flow for a new user
1. OAuth (GitHub) → 2. `register_account` with email + token + CIF (live-probed, encrypted, throttled 5/hr) → 3. chat.

---

## 🛠 MCP tools (16)

| Tool | Purpose | Confirm required |
|---|---|---|
| `create_draft` | Draft invoice (smart defaults: series, 21% VAT, RON, today) | no |
| `finalize_invoice` | Issue a draft (number assigned) | **yes** |
| `send_invoice` | Email the invoice to the client | **yes** |
| `record_payment` | Record a payment | **yes** |
| `cancel_invoice` | Cancel an invoice | **yes** |
| `storno` | Reverse (storno) an invoice | **yes** |
| `invoice_status` | Ledger + live payment status | no |
| `get_pdf` | Invoice PDF (base64) | no |
| `list_series` / `list_tax` | V1 reads (series, VAT rates) | no |
| `list_clients` / `list_products` | V3 reads (registry; typed "V3 not configured" if no V3 token) | no |
| `search_invoices` | Search ledger (client/status/date/text) | no |
| `count_totals` | Conversational counts + sums (with status breakdown) | no |
| `register_account` | Bind the caller's own SmartBill creds | no |
| `sync_ledger` | Upsert external invoice rows (Facturi emise export) for full-history Q&A | no |

---

## 🗣 Conversational verbs (the Hermes skill)

The `accounting-invoicing` Hermes skill (`hermes/skills/accounting/invoicing/`) maps chat to tools:

`create` · `send` · `pdf` · `pay` · `cancel` · `storno` · `status` · `totals` · `ask` · `sync` · `upload` (invoice file → vision-parse → confirm → draft)

- **Reply-chain:** replying "send it" to the agent's message acts on *that* invoice — no numbers to type.
- **Wizard:** `create` asks one field per turn with smart defaults + client autocomplete.
- **Upload:** send a PDF/photo → agent parses it (client, line items, VAT) → shows summary → yes → drafts. Receipts can route to the expense pipeline with an extra confirmation.
- **Guidance mode:** ambiguous messages get one short question + 2-3 interpretations, never a wall of options.

---

## 🔐 Security model

- **SmartBill creds:** never in git/logs/tool output. Only in `.dev.vars` (local), `wrangler secret` (prod), or AES-GCM-encrypted D1 rows (key = `ENCRYPTION_KEY` secret — never regenerate after data exists).
- **Identity:** GitHub OAuth. Default invite-only via `ALLOWED_GITHUB_LOGINS`; **open registration** (`OPEN_REGISTRATION=true`) lets any authenticated GitHub user bind their own account — `register_account` is live-probed, throttled (5/hr), overwrite-guarded.
- **Approval gate:** committal tools require `confirm:true` (zod-validated) AND an unambiguous chat "yes". "yeah"/emoji/silence are NOT yes.
- **Rate limits:** SmartBill allows 3 calls/sec with a 10-min account-wide block; the server throttles per tenant.

---

## 🧾 Known limitations (honest)

- **No invoice-list API** — SmartBill's API (verified 2026-08-21 spec, 30 paths) has no way to enumerate invoices. Ledger-based counts cover MCP-created invoices; full history needs a one-time `sync` of the **Facturi emise → Export Excel**.
- **No webhooks** — nothing pushes changes; the ledger updates on each action.
- **Email-only sending** — no SMS/WhatsApp invoice delivery.
- **V3 token optional** — V3 (clients/products reads) needs a Bearer token from the Integrări page; V1 token alone disables those two reads gracefully.
- **Plan gating** — online-store API integration is documented for **Facturare Platinum**; bare API on lower plans is undocumented (test your plan if registration fails).
- **No sandbox** — live tests run against production (QA uses TEST clients + immediate storno).

---

## 📦 Repo layout

```
src/                 worker source (auth, smartbill clients, tools, ledger)
migrations/          D1 schema (tenants, invoices, audit_events)
tests/               vitest suite (75 tests, >83% coverage)
hermes/skills/       the accounting-invoicing Hermes skill + references
specs/               downloaded SmartBill OpenAPI spec
EXECUTION_STATUS.md  live deployment + verification state (updated as we go)
.omo/plans/          the original work plan
```

## 🚀 Deploy / update

```bash
npm ci
npx vitest run && npx tsc --noEmit
npx wrangler secret put <NAME>   # SMARTBILL_*, GITHUB_CLIENT_*, COOKIE_ENCRYPTION_KEY, ENCRYPTION_KEY, OWNER_GITHUB_LOGIN, ALLOWED_GITHUB_LOGINS, OPEN_REGISTRATION
npx wrangler d1 migrations apply smartbill-ledger --remote
npx wrangler deploy
```

Branch: `dev` (default). All work is committed and pushed there.
