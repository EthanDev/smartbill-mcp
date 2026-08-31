# smartbill-mcp

A **conversational invoice engine for SmartBill.ro** — a remote MCP (Model Context Protocol) server on Cloudflare Workers that turns plain chat messages into real invoices. Anyone with a SmartBill account can connect their own company and then create, send, pay, cancel, and ask questions about invoices **entirely through chat** (Telegram, WhatsApp, or any MCP-capable AI tool).

**Live endpoint:** `https://smartbill-mcp.ethan1709.workers.dev/mcp` (OAuth-protected)

---

## ⚡ Zero to working in 5 minutes

The complete first-time experience, end to end:

### 1. Get the link (done)
You share (or receive) one address: `https://smartbill-mcp.ethan1709.workers.dev/mcp`. That's the whole setup.

### 2. Plug it into your AI tool (1 min)
- **Hermes** — one line in `~/.hermes/config.yaml` (see *How to connect* below).
- **Claude** (Desktop/Code) — one config block, restart.
- **Codex** — one config block, restart.

### 🚀 One-command install (Claude + Codex + Hermes skill)
Clone the repo (or download `install.sh`) and run:
```bash
git clone https://github.com/EthanDev/smartbill-mcp.git /tmp/smartbill-mcp
cd /tmp/smartbill-mcp && ./install.sh
```
The script detects Claude, Codex, and Hermes on the machine and registers the MCP server + installs the `accounting-invoicing` skill for each. Restart your tool, complete the GitHub sign-in, register your SmartBill account, and chat.

### 3. Sign in with GitHub (30 sec)
A browser opens: **"Sign in with GitHub" → Authorize.** That's your identity, once.

### 4. Connect YOUR SmartBill account (2 min)
The assistant asks for three values — all on one page (**cloud.smartbill.ro → Contul meu → Integrări**, token at the bottom):
- login **email** · **API token** · **CIF**

It tests them instantly, stores them encrypted, and says **"Account connected."** 2FA doesn't matter — it only protects web login, never the API token. *(Optional for quotes: one "proforma" series in Configurare → Serii.)*

### 5. Just chat
```
You:  create invoice for Acme 500 RON
AI:   Acme SRL | SR 29 | 605 RON (inc. VAT) | due +30d — reply "yes" to issue
You:  yes
AI:   ✓ Issued. Say "send it", "pdf", or "pay".
```
That's it — you never open the SmartBill web app again.

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

> **Quotes (proforma) need one more setup step:** create a proforma series in SmartBill first (Configurare → Serii → New series, type **Proforma**, e.g. `SRP`). Without it, the agent tells you exactly what to do. Invoices work out of the box.

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
| `how much did Acme pay me in the last 6 months?` | `count_totals(client=Acme, status=paid, from/to)` — date-range accounted |
| `sync` | Imports their Facturi emise Excel export so counts cover their full history |

**Safety rule:** nothing committal (issue, send, pay, cancel, storno) ever happens without an unambiguous **"yes"** in chat — confirmed twice: the chat gate and a machine-checked `confirm:true`.

### Real conversations (what it actually looks like)

**Invoice:**
```
You:  create invoice for Acme SRL 500 RON
Bot:  Team. Draft ready: Acme SRL | SR 29 | 605 RON (inc. 21% VAT) | acme@x.ro
      Reply "yes" to issue, "no" to cancel.
You:  yes
Bot:  ✓ Issued SR 29. Say "send it" to email, "pay" to record payment, "pdf" for the file.
You:  send it
Bot:  Email to acme@x.ro? Reply yes to confirm.
You:  yes
Bot:  ✓ Sent.
```

**Quote → invoice:**
```
You:  quote Beta SRL for 300 RON
Bot:  Proforma created: SRP 1 — Beta SRL, 300 RON. Say "invoice it" when they accept.
You:  invoice it
Bot:  Convert SRP 1 to an invoice? Reply yes.
You:  yes
Bot:  ✓ Converted to SR 30.
```

**Questions:**
```
You:  how many invoices do I have this month?
Bot:  You have 12 invoice(s). Breakdown: issued: 5, paid: 5, storno: 2. Sum total: 4 800 RON.
You:  what's unpaid for Acme?
Bot:  Acme SRL: SR 25 (unpaid 605 RON), SR 28 (unpaid 1 210 RON). Total unpaid: 1 815 RON.
```

**Upload a PDF/photo:**
```
You:  [attach invoice PDF]
Bot:  I read: Acme SRL (CIF RO12345678), IT consulting, 500 RON, 21% VAT, issued 2026-08-15.
      Draft this? Reply yes.
You:  yes
Bot:  ✓ Drafted SR 31. Reply "finalize" to issue.
```

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

Then: `hermes mcp login smartbill-mcp` (browser opens once, GitHub sign-in) → `hermes mcp test smartbill-mcp` → 31 tools.

### Claude Desktop / Claude Code
Remote MCP servers over HTTP use an OAuth flow with a proxy:

1. Put this in Claude's MCP config (`claude_desktop_config.json` or `~/.claude.json`):
   ```json
   {
     "mcpServers": {
       "smartbill-mcp": {
         "command": "npx",
         "args": ["-y", "mcp-remote", "https://smartbill-mcp.ethan1709.workers.dev/mcp"]
       }
     }
   }
   ```
2. Restart Claude → a browser opens → sign in with GitHub → Authorize.
3. The 31 tools appear as `mcp__smartbill-mcp__*`. Claude's `mcp-remote` wrapper caches + refreshes the OAuth token automatically.

### Codex (OpenAI CLI)
Codex doesn't support `.json`-declared HTTP MCP servers natively yet; the supported pattern is a stdio bridge:

1. Install the bridge and register it in `~/.codex/config.toml`:
   ```toml
   [mcp_servers.smartbill-mcp]
   command = "npx"
   args = ["-y", "mcp-remote", "https://smartbill-mcp.ethan1709.workers.dev/mcp"]
   ```
2. Restart Codex → complete the GitHub OAuth in the browser → the tools are available.

### Any other MCP client
Point it at `https://smartbill-mcp.ethan1709.workers.dev/mcp` and complete the OAuth flow in the browser (standard OAuth 2.1 + dynamic client registration + refresh).

### First-use flow for a new user
1. OAuth (GitHub) → 2. `register_account` with email + token + CIF (live-probed, encrypted, throttled 5/hr) → 3. chat.

---

## 🧩 Claude Code plugin (smartro)

One-command install of this MCP server + the `smartro` invoicing skill as a Claude Code plugin:

```
/plugin marketplace add EthanDev/smartbill-mcp
/plugin install smartro@smartro
/reload-plugins
```

**First use:** GitHub OAuth (a browser opens) → register your SmartBill account (email + token + CIF) → chat.

> **Note:** the repo is public; the skill is invoked as `/smartro:smartro`.

---

## 🛠 MCP tools (31)

| Tool | Purpose | Confirm required |
|---|---|---|
| `create_draft` | Draft invoice (smart defaults: series, 21% VAT, RON, today) | no |
| `finalize_invoice` | Issue a draft (number assigned) | **yes** |
| `send_invoice` | Email the invoice (or proforma via `docType`) to the client | **yes** |
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
| `create_proforma` | Proforma/quote with smart defaults (needs a "proforma" series in SmartBill) | no |
| `convert_proforma` | Turn an accepted quote into a real invoice (pulls client/products from it) | **yes** |
| `estimate_invoices` | Check whether a proforma was converted to an invoice | no |
| `proforma_pdf` | Proforma PDF (base64) | no |
| `cancel_proforma` / `restore_proforma` / `delete_proforma` | Proforma lifecycle (delete = last-in-series) | **yes** (cancel, delete) |
| `restore_invoice` | Restore a cancelled invoice | no |
| `delete_invoice` | Delete an invoice (last-in-series) | **yes** |
| `list_stocks` | Inventory stock levels for a date, filtrable by warehouse/product | no |
| `payment_text` | Fiscal receipt data (bon fiscal) | no |
| `delete_payment` / `delete_chitanta` | Delete a payment / receipt | **yes** |
| `client_balances` | Per-client: issued / paid / outstanding, ranked by what they owe | no |
| `overdue_invoices` | Past-due with days-overdue + aging buckets (0-30/31-60/61-90/90+) | no |

---

## 🗣 The conversation layer (not a command parser)

**This is a conversational agent, not a keyword chatbot.** You talk like a person — full sentences, references, corrections, compound requests — and the agent understands:

- **Entity extraction** — "send Acme 500 for last month's hosting" → client/amount/product/date pulled from free text. No command grammar to learn.
- **Conversational memory** — "send it", "the Acme one", "the other one" resolve from what was just discussed. No invoice numbers to type.
- **Compound requests** — "create it, email it, and mark it paid" → planned once, then executed step-by-step with a confirmation at each committal step.
- **Corrections** — "no, the other one" → the agent re-resolves, restates what it now thinks, and proceeds.
- **Follow-ups** — "did it go through?" → answered from the ledger + live payment status.
- **One proactive suggestion** after each action ("say 'finalize' to issue, 'pdf' to preview"), never a wall of options.

Quick verbs are a *shortcut*, not a requirement — saying `pdf 123` and saying "show me the PDF for that invoice from last week" both work:

| You say (anything like this) | What happens |
|---|---|
| `create invoice for Acme 500 RON` | Wizard fills gaps → confirmation card → **yes** → issued |
| `send Acme the one from last week` | Resolves the invoice from memory → gate → emailed |
| `quote Beta 300, invoice it if they accept` | Quote → converts when you say "invoice it" |
| `make it in English / creează factura în engleză` | Document language = EN (product names translated) |
| `how many did we issue in July?` / `what's unpaid?` | Conversational answer with breakdown |
| `[attach invoice PDF]` | Vision-parsed → summary → **yes** → drafted |

The MCP server provides 31 tools; the **skill** (`accounting-invoicing`) teaches the agent how to converse with them — understood by Hermes, Claude, and Codex alike.

---

## 🔐 Security model

- **SmartBill creds:** never in git/logs/tool output. Only in `.dev.vars` (local), `wrangler secret` (prod), or AES-GCM-encrypted D1 rows (key = `ENCRYPTION_KEY` secret — never regenerate after data exists).
- **Identity:** GitHub OAuth. Default invite-only via `ALLOWED_GITHUB_LOGINS`; **open registration** (`OPEN_REGISTRATION=true`) lets any authenticated GitHub user bind their own account — `register_account` is live-probed, throttled (5/hr), overwrite-guarded.
- **Approval gate:** committal tools require `confirm:true` (zod-validated) AND an unambiguous chat "yes". "yeah"/emoji/silence are NOT yes.
- **Rate limits:** SmartBill allows 3 calls/sec with a 10-min account-wide block; the server throttles per tenant.

---

## 🌍 Multilingual chat & documents

**The chat itself is fully multilingual.** The MCP server is language-agnostic — the Hermes skill (or Claude/Codex) understands Romanian, English, French, German, etc. and answers in the same language you use. Say `creează factură pentru Acme` or `make an invoice for Acme` — same result.

**Document language** (what the PDF/email shows) is a separate, explicit thing:

- Documents default to **Romanian (RO)**.
- Pass `language: "EN"` (or any language configured in your SmartBill account) to issue a document in another language — e.g. `create invoice for Acme 500 RON in English`.
- For non-Romanian documents, product display names/units need translations per product:
  - `translatedName` — the product name as it appears on the foreign-language document
  - `translatedMeasuringUnit` — the unit (e.g. "hour") as it appears
- The client/company names, addresses, etc. appear as stored; only the document boilerplate + product names switch language.

> Note: `language` must match a language **configured in the SmartBill account** (SmartBill Cloud → Configurare → Limbi / document defaults). If the agent receives a language that isn't configured, SmartBill returns an error — the agent should confirm the available languages.

---

## 🧾 Known limitations (honest)

- **No invoice-list API** — SmartBill's API (verified 2026-08-21 spec, 30 paths) has no way to enumerate invoices. Ledger-based counts cover MCP-created invoices; full history needs a one-time `sync` of the **Facturi emise → Export Excel**.
- **No supplier/purchase data** — "how much did I pay a supplier" is NOT possible: the API has no purchase-invoice endpoints (only a read-only suppliers list). The ledger answers client-side questions only (what clients owe, what they paid).
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
tests/               vitest suite (84 tests, >83% coverage)
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
