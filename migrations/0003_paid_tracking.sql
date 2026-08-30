-- Track received amounts and dates so "how much did X pay me" is answerable from the ledger.
ALTER TABLE invoices ADD COLUMN paid_ron REAL;
ALTER TABLE invoices ADD COLUMN payment_date TEXT;
