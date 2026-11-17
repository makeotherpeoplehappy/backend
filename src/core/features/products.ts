// Shopify webhook subscriptions for this backend. Products are no longer
// copied into Webflow: the shop is Shopify's own, and the backend only reads
// Shopify (drops, stock, orders).

import type { Deps, Env } from '../env';
import { adminGraphql, customerGid } from '../shopify';

// ---------------------------------------------------------------------------
// Shopify webhook subscriptions for this backend.
// ---------------------------------------------------------------------------

const TOPICS = ['PRODUCTS_CREATE', 'PRODUCTS_UPDATE', 'PRODUCTS_DELETE', 'CUSTOMERS_DELETE', 'ORDERS_CREATE', 'ORDERS_UPDATED', 'ORDERS_CANCELLED', 'REFUNDS_CREATE'] as const;

/** Makes sure Shopify sends order, product and customer-deletion events to this backend. */
export async function ensureShopifyWebhooks(env: Env, deps: Deps, callbackUrl: string) {
  const existing = await adminGraphql<{ webhookSubscriptions: { nodes: { id: string; topic: string; uri?: string | null }[] } }>(
    env,
    deps,
    `query { webhookSubscriptions(first: 50) { nodes { id topic uri } } }`,
  );
  const have = new Set(existing.webhookSubscriptions.nodes.filter((n) => n.uri === callbackUrl).map((n) => n.topic));
  const created: string[] = [];
  const errors: string[] = [];
  for (const topic of TOPICS) {
    if (have.has(topic)) continue;
    const r = await adminGraphql<{ webhookSubscriptionCreate: { userErrors: { message: string }[] } }>(
      env,
      deps,
      `mutation ($topic: WebhookSubscriptionTopic!, $uri: String!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: { uri: $uri, format: JSON }) { userErrors { message } }
      }`,
      { topic, uri: callbackUrl },
    );
    const errs = r.webhookSubscriptionCreate.userErrors;
    if (errs.length) errors.push(`${topic}: ${errs.map((e) => e.message).join('; ')}`);
    else created.push(topic);
  }
  return { callbackUrl, alreadyThere: [...have], created, errors };
}

export { customerGid };
