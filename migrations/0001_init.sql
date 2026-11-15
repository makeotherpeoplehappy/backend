-- Happiness Foundation backend: initial schema.
-- All dates are ISO 8601 strings in UTC.

CREATE TABLE members (
  id INTEGER PRIMARY KEY,
  -- Shopify customer GID (gid://shopify/Customer/123). Replaced with
  -- 'deleted:<id>' when the member deletes their account.
  shopify_customer_id TEXT NOT NULL UNIQUE,
  first_name TEXT,
  -- Needed only to send the member's own notification emails.
  email TEXT,
  notify_invite_summary INTEGER NOT NULL DEFAULT 1,
  notify_story_approved INTEGER NOT NULL DEFAULT 1,
  notify_suggestion_live INTEGER NOT NULL DEFAULT 1,
  notify_pledge_reminder INTEGER NOT NULL DEFAULT 1,
  -- Set once (Phase 4).
  inviter_id INTEGER REFERENCES members(id),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT
);

-- Mirror of the Webflow Actions collection, keyed by CMS item ID.
CREATE TABLE actions (
  cms_item_id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  short_answer TEXT,
  can_do_with_others INTEGER NOT NULL DEFAULT 0,
  -- published | removed
  status TEXT NOT NULL DEFAULT 'published',
  synced_at TEXT NOT NULL
);
CREATE INDEX actions_slug ON actions(slug);

CREATE TABLE done_marks (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  action_id TEXT NOT NULL,
  done_at TEXT NOT NULL,
  action_title TEXT NOT NULL,
  -- site | import
  source TEXT NOT NULL DEFAULT 'site',
  -- Set for imported marks so a re-run of the import adds nothing.
  import_key TEXT UNIQUE
);
CREATE INDEX done_marks_member ON done_marks(member_id, done_at);
CREATE INDEX done_marks_action ON done_marks(action_id, member_id);

CREATE TABLE likes (
  member_id INTEGER NOT NULL REFERENCES members(id),
  action_id TEXT NOT NULL,
  -- 1 is a like. -1 is an imported "don't like", kept as a private signal.
  value INTEGER NOT NULL CHECK (value IN (1, -1)),
  updated_at TEXT NOT NULL,
  source TEXT NOT NULL DEFAULT 'site',
  PRIMARY KEY (member_id, action_id)
);

CREATE TABLE suggestions (
  id INTEGER PRIMARY KEY,
  -- NULL once the member has deleted their account.
  member_id INTEGER REFERENCES members(id),
  text TEXT NOT NULL,
  -- new | approved | rejected
  status TEXT NOT NULL DEFAULT 'new',
  cms_item_id TEXT,
  draft_action_id TEXT,
  similar_notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX suggestions_member ON suggestions(member_id);

CREATE TABLE stories (
  id INTEGER PRIMARY KEY,
  member_id INTEGER NOT NULL REFERENCES members(id),
  action_id TEXT NOT NULL,
  text TEXT,
  photo_key TEXT,
  photo_description TEXT,
  video_url TEXT,
  show_name INTEGER NOT NULL DEFAULT 1,
  -- new | approved | rejected
  status TEXT NOT NULL DEFAULT 'new',
  cms_item_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (member_id, action_id)
);

CREATE TABLE story_with (
  story_id INTEGER NOT NULL REFERENCES stories(id),
  member_id INTEGER NOT NULL REFERENCES members(id),
  PRIMARY KEY (story_id, member_id)
);

CREATE TABLE invites (
  code TEXT PRIMARY KEY,
  inviter_id INTEGER NOT NULL REFERENCES members(id),
  action_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('with_me', 'pass_it_on')),
  team_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE invite_joins (
  id INTEGER PRIMARY KEY,
  invite_code TEXT NOT NULL REFERENCES invites(code),
  member_id INTEGER NOT NULL REFERENCES members(id),
  joined_at TEXT NOT NULL,
  left_at TEXT,
  UNIQUE (invite_code, member_id)
);

CREATE TABLE pledges (
  id INTEGER PRIMARY KEY,
  shopify_order_id TEXT NOT NULL,
  shopify_line_id TEXT NOT NULL,
  -- Position within the line, so an order of two pieces is two pledges.
  piece INTEGER NOT NULL,
  drop_id TEXT,
  buyer_email TEXT,
  member_id INTEGER REFERENCES members(id),
  ordered_at TEXT NOT NULL,
  -- open | kept | cancelled
  status TEXT NOT NULL DEFAULT 'open',
  kept_by_done_mark_id INTEGER REFERENCES done_marks(id),
  reminder_sent_at TEXT,
  UNIQUE (shopify_order_id, shopify_line_id, piece)
);

-- Writes to Webflow, Shopify and the email service, waiting or being retried.
CREATE TABLE outbox (
  id INTEGER PRIMARY KEY,
  -- webflow | shopify | email
  target TEXT NOT NULL,
  op TEXT NOT NULL,
  payload TEXT NOT NULL,
  -- One row per logical write, so a retried request never queues it twice.
  dedupe_key TEXT NOT NULL UNIQUE,
  member_id INTEGER,
  -- pending | running | done | dead | cancelled
  status TEXT NOT NULL DEFAULT 'pending',
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  locked_until TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX outbox_due ON outbox(status, next_attempt_at);

-- One-time request keys: a retry with the same key gets the first answer.
CREATE TABLE request_keys (
  scope TEXT NOT NULL,
  key TEXT NOT NULL,
  route TEXT NOT NULL,
  -- pending | done
  status TEXT NOT NULL,
  response_status INTEGER,
  response_body TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (scope, key)
);

-- Daily limits per member and kind of write (UTC days).
CREATE TABLE daily_usage (
  member_id INTEGER NOT NULL,
  kind TEXT NOT NULL,
  day TEXT NOT NULL,
  count INTEGER NOT NULL,
  PRIMARY KEY (member_id, kind, day)
);

-- Pause per external service after a rate-limit answer.
CREATE TABLE rate_state (
  target TEXT PRIMARY KEY,
  paused_until TEXT NOT NULL
);

CREATE TABLE job_runs (
  job TEXT PRIMARY KEY,
  last_run_at TEXT NOT NULL
);
