-- Weekly dare: the Actions mirror keeps the fields that decide this week's dare.
ALTER TABLE actions ADD COLUMN weekly_dare_from TEXT;
ALTER TABLE actions ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;
ALTER TABLE actions ADD COLUMN location_specific INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS actions_dare ON actions(weekly_dare_from);
