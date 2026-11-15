-- "Notify me when this drop goes live" sign-ups. The email itself is kept
-- only in Shopify (customer with marketing consent and a drop tag); here we
-- keep a one-way hash so a person counts once per drop.
CREATE TABLE drop_signups (
  drop_slug TEXT NOT NULL,
  email_hash TEXT NOT NULL,
  member_id INTEGER,
  created_at TEXT NOT NULL,
  PRIMARY KEY (drop_slug, email_hash)
);
CREATE INDEX drop_signups_created ON drop_signups(created_at);
