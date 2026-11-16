-- Phases 2 to 4: suggestions review, stories, counts, pledges, stock, ripple.

-- The suggestion an action came from (Phase 2, "Suggested by").
ALTER TABLE actions ADD COLUMN suggestion_cms_id TEXT;

-- "Your action is live" is sent once.
ALTER TABLE suggestions ADD COLUMN live_notified_at TEXT;

-- The name a member chose for sharing, when Shopify has none (Phase 4), and
-- when their inviter was set, so only later actions count toward the ripple.
ALTER TABLE members ADD COLUMN share_name TEXT;
ALTER TABLE members ADD COLUMN inviter_joined_at TEXT;

-- Joins are summarised once a day in one email per inviter.
ALTER TABLE invite_joins ADD COLUMN summarized_at TEXT;
CREATE INDEX invite_joins_member ON invite_joins(member_id);
CREATE INDEX invites_inviter ON invites(inviter_id, action_id, kind);

-- Stories: each edit is a new version; an approval email goes once per version.
ALTER TABLE stories ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE stories ADD COLUMN approved_version INTEGER;

-- Pledges: which Shopify product the piece was.
ALTER TABLE pledges ADD COLUMN product_id TEXT;
CREATE INDEX pledges_member ON pledges(member_id, status, ordered_at);
CREATE INDEX pledges_email ON pledges(buyer_email);
CREATE INDEX pledges_drop ON pledges(drop_id, status);

-- The last counts written to the CMS, so only changes are written.
CREATE TABLE cms_counts (
  action_id TEXT PRIMARY KEY,
  done_count INTEGER NOT NULL,
  votes INTEGER NOT NULL,
  written_at TEXT NOT NULL
);

-- Drop products held back in Shopify until the drop's date and time.
CREATE TABLE drop_releases (
  product_id TEXT PRIMARY KEY,
  drop_slug TEXT NOT NULL,
  release_at TEXT NOT NULL,
  scheduled_at TEXT NOT NULL
);
