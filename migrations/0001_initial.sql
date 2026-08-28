CREATE TABLE tenants(id TEXT PRIMARY KEY, user_id TEXT UNIQUE NOT NULL, smartbill_email TEXT NOT NULL, token_enc BLOB NOT NULL, token_iv BLOB NOT NULL, cif TEXT NOT NULL, cif_fallback TEXT, created_at TEXT DEFAULT (datetime('now')));

CREATE TABLE invoices(id INTEGER PRIMARY KEY AUTOINCREMENT, draft_id TEXT UNIQUE, user_id TEXT NOT NULL, series TEXT NOT NULL, number TEXT, doc_type TEXT DEFAULT 'factura', status TEXT CHECK(status IN ('draft','issued','sent','paid','cancelled','storno')), client_name TEXT, client_cif TEXT, issue_date TEXT, due_date TEXT, total_ron REAL, currency TEXT DEFAULT 'RON', pdf_path TEXT, idempotency_key TEXT, created_at TEXT, updated_at TEXT);

CREATE UNIQUE INDEX ux_invoices_issued ON invoices(user_id, series, number) WHERE number IS NOT NULL;

CREATE TABLE audit_events(id INTEGER PRIMARY KEY AUTOINCREMENT, invoice_id INTEGER, user_id TEXT, event TEXT, actor TEXT, at TEXT DEFAULT (datetime('now')));
