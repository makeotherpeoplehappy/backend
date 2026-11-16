-- Reviews done from /lab: who decided and when.
ALTER TABLE suggestions ADD COLUMN reviewed_by TEXT;
ALTER TABLE suggestions ADD COLUMN reviewed_at TEXT;
ALTER TABLE stories ADD COLUMN reviewed_by TEXT;
ALTER TABLE stories ADD COLUMN reviewed_at TEXT;
