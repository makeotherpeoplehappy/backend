-- What the backend last sent to Memberstack for Active membership (1 Active plan,
-- 0 Inactive plan, NULL not sent yet), so every member is synced exactly once per change.
ALTER TABLE members ADD COLUMN ms_active INTEGER;
