-- Shareable proof: who an action makes happy (for the card line), each member's
-- referral code (in shared links), and which member's link brought a done mark.
ALTER TABLE actions ADD COLUMN who TEXT;
ALTER TABLE members ADD COLUMN ref_code TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS members_ref_code ON members(ref_code);
ALTER TABLE done_marks ADD COLUMN parent_member_id INTEGER REFERENCES members(id);
CREATE INDEX IF NOT EXISTS done_marks_parent ON done_marks(parent_member_id);
