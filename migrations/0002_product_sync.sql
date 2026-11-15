-- Which Shopify product is which Webflow Products item, and what was last
-- copied, so an unchanged product is not written to Webflow again.
CREATE TABLE product_sync (
  shopify_id TEXT PRIMARY KEY,
  cms_item_id TEXT,
  -- Hash of the fields copied from Shopify at the last successful write.
  source_hash TEXT,
  -- live | removed
  state TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
