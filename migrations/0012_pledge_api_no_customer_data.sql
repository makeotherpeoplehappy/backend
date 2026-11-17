-- The Pledge API takes no customer data: partners send no order number and no
-- email. Each partner pledge has our own reference (pl_…), which the partner may
-- keep to cancel it. Partners get a monthly report of their pledges in numbers.

-- No partner emails are kept (our own shop's buyers still get their claim email).
UPDATE pledges SET buyer_email = NULL WHERE partner_id != 1;

-- Where the monthly report goes, and the last month that was sent.
ALTER TABLE partners ADD COLUMN report_email TEXT;
ALTER TABLE partners ADD COLUMN last_report_month TEXT;
