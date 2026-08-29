# Connecting your SmartBill account (for any user)

## Two-step authentication (2FA) — what you need to know
SmartBill's 2FA ("autentificare în doi pași") affects ONLY your **web login** and a small set of
portal actions (changing IBAN, adding users, account info, password reset). It does NOT affect
API access: your **API token works over static Basic auth with no 2FA code, forever**, until you
regenerate it. Source: ajutor.smartbill.ro articles 20/186/187 + api.smartbill.ro.

So: enable 2FA freely — it protects your portal login; it never blocks the MCP.

## Steps to connect
1. Log in at cloud.smartbill.ro (enter your 2FA code here if enabled).
2. Go to **Contul meu → Integrări** — the API token is at the **bottom of the page** (API section).
3. Copy: your **login email**, the **API token**, and the **CIF** (Configurare → Datele firmei → Generale).
4. Send those three to the agent (or use the `register_account` tool). The server probes the
   token live, encrypts it at rest (AES-GCM), and throttles to 5 attempts/hour.

## Notes
- Plan gating: the online-store API option is documented for **Facturare Platinum**; bare API
  availability on lower plans is not clearly documented — if registration fails, check your plan.
- Rate limit: **3 calls/second, 10-minute block** on violation (account-wide) — the server
  throttles per tenant so you should never hit it.
- The token is account-wide (no per-token scopes): anyone holding it can create/manage invoices.

## "How many invoices do I have?" — the honest scope
SmartBill's API has NO invoice-list endpoint (verified against the 2026-08-21 OpenAPI spec: 30
paths, zero invoice listing, zero webhooks). The ledger answers counts for:
- invoices created through this MCP (always), plus
- your full history if you sync it: **Facturi emise → Export Excel** (cloud.smartbill.ro/raport/facturi/),
  converted to the rows format, via the `sync_ledger` tool (or the e-Facturi ZIP).
