-- The shop moved to Shopify: products are no longer copied into Webflow, and
-- "Notify me" sign-ups are Shopify customer tags (notify-drop-<handle>).
DROP TABLE IF EXISTS product_sync;
DROP TABLE IF EXISTS drop_signups;
