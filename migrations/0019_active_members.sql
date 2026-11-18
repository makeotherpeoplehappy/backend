-- Active membership: a member is Active after making someone happy in at least
-- 4 of the last 5 weeks (Monday to Sunday, UTC). Worked out after every
-- "I did this" or undo, and once a day.
ALTER TABLE members ADD COLUMN active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE members ADD COLUMN active_since TEXT;
CREATE INDEX done_marks_time ON done_marks(done_at);
