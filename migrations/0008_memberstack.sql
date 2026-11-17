-- Foundation sign-in moves from Shopify customer accounts to Memberstack.
-- The column now holds the member's account ID: a Memberstack ID (mem_...),
-- or, for members who have not signed in since the move, their old Shopify
-- customer GID until they sign in with the same verified email.
ALTER TABLE members RENAME COLUMN shopify_customer_id TO account_id;
