-- Try before sign-up: guests are member rows with account_id 'guest:<hash of the device key>'.
-- Closed guests become 'merged:<id>' (claimed on sign-in) or 'expired:<id>' (30 days unclaimed).
-- This index finds guests to expire without scanning every member.
CREATE INDEX IF NOT EXISTS members_updated ON members(updated_at);
