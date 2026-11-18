-- The shop is back on this site (Shopify behind it, Memberstack for members).
-- What the backend last copied from Shopify into Webflow, per product or drop.
CREATE TABLE IF NOT EXISTS product_sync (
  shopify_id TEXT PRIMARY KEY,
  cms_item_id TEXT,
  source_hash TEXT,
  state TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
-- "Notify me" for a drop, kept with the member.
CREATE TABLE drop_notify (
  member_id INTEGER NOT NULL REFERENCES members(id),
  drop_slug TEXT NOT NULL,
  created_at TEXT NOT NULL,
  notified_at TEXT,
  PRIMARY KEY (member_id, drop_slug)
);
CREATE INDEX drop_notify_due ON drop_notify(drop_slug, notified_at);
-- Checkouts started from the site (for the Lab and support; orders arrive by webhook).
CREATE TABLE checkouts (
  id INTEGER PRIMARY KEY,
  member_id INTEGER REFERENCES members(id),
  variant_id TEXT NOT NULL,
  product_handle TEXT NOT NULL,
  status_at_start TEXT NOT NULL,
  cart_id TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX checkouts_time ON checkouts(created_at);
