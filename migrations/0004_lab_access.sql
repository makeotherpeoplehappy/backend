-- People invited to /lab from the page itself. Owners listed in the
-- LAB_EMAILS setting always have access and are not stored here.
CREATE TABLE lab_access (
  email TEXT PRIMARY KEY,
  added_by TEXT NOT NULL,
  added_at TEXT NOT NULL
);
