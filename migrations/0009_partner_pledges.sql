-- Pledges from any partner shop, kept on the foundation through a claim link.
-- A partner registers pledges with its key (server to server) and gets back a
-- "Keep your pledge" link for the buyer; signing in on the foundation with that
-- link makes the pledges the member's. Our own Shopify shop is partner 1.

CREATE TABLE partners (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  -- Short name used in order references, e.g. "shop".
  slug TEXT NOT NULL UNIQUE,
  -- SHA-256 of the partner's key; the key itself is shown once, never stored.
  key_hash TEXT UNIQUE,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT,
  created_at TEXT NOT NULL
);
INSERT INTO partners (id, name, slug, key_hash, active, created_at) VALUES (1, 'Happiness Foundation shop', 'shop', NULL, 1, '2026-11-17T00:00:00Z');

-- One claim per partner order; the code is in the buyer's link.
CREATE TABLE pledge_claims (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  order_ref TEXT NOT NULL,
  -- SHA-256 of the claim code.
  code_hash TEXT NOT NULL UNIQUE,
  member_id INTEGER REFERENCES members(id),
  claimed_at TEXT,
  email_sent_at TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (partner_id, order_ref)
);

-- Pledges get partner-neutral references and their partner and claim.
ALTER TABLE pledges RENAME COLUMN shopify_order_id TO order_ref;
ALTER TABLE pledges RENAME COLUMN shopify_line_id TO line_ref;
ALTER TABLE pledges ADD COLUMN partner_id INTEGER NOT NULL DEFAULT 1; -- partners(id); 1 = our shop
ALTER TABLE pledges ADD COLUMN claim_id INTEGER REFERENCES pledge_claims(id);
CREATE INDEX pledges_claim ON pledges (claim_id);
