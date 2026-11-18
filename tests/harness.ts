// Test harness: real SQLite (D1), key-value (KV) and object storage (R2)
// from Miniflare, the same runtime Webflow Cloud uses, with fake Shopify,
// Webflow, Resend and Turnstile services behind an injected fetch.

import { MEMBERSTACK_APP_ID } from '../src/core/config';
import { readFileSync, readdirSync } from 'node:fs';
import { Miniflare } from 'miniflare';
import { createApp } from '../src/core/app';
import { CMS } from '../src/core/config';
import type { Env } from '../src/core/env';

export const SITE = 'https://happiness-foundation.webflow.io';
export const STORE = 'r40e0y-zs.myshopify.com';
const CUSTOMER_API = 'https://shopify.com/79948841151/account/customer/api/2025-10/graphql';

export interface FakeCustomer {
  id: string;
  firstName: string | null;
  email: string | null;
  /** Memberstack: whether the member's email is verified (default true). */
  verified?: boolean;
  /** Memberstack: the member's profile photo address. */
  profileImage?: string | null;
  actionsTaken?: string; // raw metafield JSON
  actionVotes?: string;
}

export interface FakeProduct {
  id: string;
  handle: string;
  title: string;
  status: 'ACTIVE' | 'DRAFT' | 'ARCHIVED';
  descriptionHtml: string;
  description: string;
  seoDescription?: string | null;
  imageUrl?: string | null;
  editionSize?: number;
}

export interface FakeItem {
  id: string;
  isDraft: boolean;
  live: boolean;
  fieldData: Record<string, unknown>;
  /** What the live site shows (set when published). */
  liveFieldData?: Record<string, unknown>;
}

export class FakeServices {
  /** token -> customer */
  tokens = new Map<string, FakeCustomer>();
  customers: FakeCustomer[] = [];
  products: FakeProduct[] = [];
  webhookSubs: { id: string; topic: string; uri: string }[] = [];
  /** Shopify orders, in the Admin GraphQL shape. */
  orders: Record<string, unknown>[] = [];
  /** Inventory by product id: null means not tracked. */
  inventory = new Map<string, number | null>();
  publications = ['gid://shopify/Publication/1', 'gid://shopify/Publication/2'];
  /** productId -> publishDate per publication, or null when unpublished. */
  published = new Map<string, Record<string, string | null>>();
  publicationsAllowed = true;
  /** Shopify collections by handle: product ids. */
  shopCollections = new Map<string, string[]>();
  /** Drops: Shopify collections with a drop date (custom.drop_date), by handle; their products are in shopCollections. */
  dropCollections = new Map<string, { title: string; description?: string; dropDate: string }>();
  /** Shopify customers created or updated by drop sign-ups, by email. */
  marketing = new Map<string, { id: string; tags: string[]; state: string; firstName?: string }>();
  /** collectionId -> items */
  items = new Map<string, FakeItem[]>();
  emails: { to: string[]; subject: string; text: string; template?: { id: string; variables: Record<string, string | number> }; headers?: Record<string, string> }[] = [];
  calls: { method: string; url: string; body?: unknown }[] = [];
  webflowDown = false;
  /** Webflow creates the item but the answer is lost (network drop). */
  webflowLoseNextCreateResponse = false;
  shopifyDown = false;
  /** Memberstack's Admin API is unreachable. */
  memberstackDown = false;
  planNotFound = false;
  /** Admin API token currently accepted (issued by the client credentials grant). */
  adminToken: string | null = null;
  adminTokensIssued = 0;
  private seq = 0;

  newId(): string {
    this.seq++;
    return (Date.now().toString(16) + this.seq.toString(16)).padStart(24, 'a').slice(-24);
  }

  collection(id: string): FakeItem[] {
    if (!this.items.has(id)) {
      this.items.set(id, []);
      if (id === 'times') this.items.get(id)!.push({ id: 'time5minutes0000000000000'.slice(0, 24), isDraft: false, live: true, fieldData: { name: '5 minutes', slug: '5-minutes' } });
      if (id === 'costs') this.items.get(id)!.push({ id: 'costfree0000000000000000', isDraft: false, live: true, fieldData: { name: 'Free', slug: 'free' } });
    }
    return this.items.get(id)!;
  }

  addAction(slug: string, name: string, doItWith: string[] = [CMS.actions.onMyOwnCompanionId]): string {
    const id = this.newId();
    this.collection(CMS.actions.id).push({ id, isDraft: false, live: true, fieldData: { name, slug, 'short-answer': `Do ${name}`, 'do-it-with': doItWith } });
    return id;
  }

  signIn(token: string, c: Partial<FakeCustomer> = {}): FakeCustomer {
    const customer: FakeCustomer = { id: c.id || `mem_${1000 + this.tokens.size}`, firstName: c.firstName ?? 'Ana', email: c.email ?? `${token}@example.com`, ...c };
    this.tokens.set(token, customer);
    if (!this.customers.find((x) => x.id === customer.id)) this.customers.push(customer);
    return customer;
  }

  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = (init.method || 'GET').toUpperCase();
    let body: unknown = undefined;
    if (typeof init.body === 'string') {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init.body instanceof FormData) {
      body = Object.fromEntries(init.body.entries());
    }
    this.calls.push({ method, url: url.href, body });
    const headers = new Headers(init.headers);
    const j = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } });

    // Shopify Customer Account API
    if (url.href === `https://${STORE}/.well-known/customer-account-api`) return j({ graphql_api: CUSTOMER_API });
    // Memberstack Admin API: member token check and member lookup.
    if (url.origin === 'https://admin.memberstack.com') {
      if (this.memberstackDown) return new Response('down', { status: 503 });
      if (headers.get('X-API-KEY') !== 'sk_sb_test') return j({ code: 'validation/invalid-secret-key', message: 'Invalid secret key' }, 400);
      if (url.pathname === '/members/verify-token' && method === 'POST') {
        const c = this.tokens.get(String((body as { token?: string })?.token || ''));
        if (!c) return j({ code: 'INVALID_TOKEN', message: 'Invalid token' }, 400);
        return j({ data: { id: c.id, type: 'member', iat: 1, exp: 2, aud: c.id.startsWith('mem_other') ? 'app_other' : MEMBERSTACK_APP_ID, iss: 'https://api.memberstack.com' } });
      }
      const plan = /^\/members\/([^/]+)\/(add|remove)-plan$/.exec(url.pathname);
      if (plan && method === 'POST') return this.planNotFound && plan[2] === 'remove' ? j({ code: 'not-found', message: 'Plan connection not found' }, 404) : j({ data: { id: decodeURIComponent(plan[1]) } });
      const m = /^\/members\/([^/]+)$/.exec(url.pathname);
      if (m && method === 'GET') {
        const c = [...this.tokens.values()].find((x) => x.id === decodeURIComponent(m[1]));
        return j({ data: c ? { id: c.id, verified: c.verified ?? true, auth: { email: c.email }, customFields: c.firstName ? { 'first-name': c.firstName } : {}, profileImage: c.profileImage ?? null } : null });
      }
    }

    // Shopify Dev Dashboard app: client credentials grant
    if (url.href === `https://${STORE}/admin/oauth/access_token`) {
      const form = new URLSearchParams(String(init.body || ''));
      if (form.get('grant_type') !== 'client_credentials' || form.get('client_id') !== 'shopify_client_id' || form.get('client_secret') !== 'shopify_webhook_secret') {
        return j({ error: 'invalid_client' }, 401);
      }
      this.adminTokensIssued++;
      this.adminToken = `shpat_issued_${this.adminTokensIssued}`;
      return j({ access_token: this.adminToken, scope: 'read_customers,write_customers', expires_in: 86399 });
    }

    // Shopify Admin API
    if (url.hostname === STORE && url.pathname.startsWith('/admin/api/')) {
      if (!this.adminToken || headers.get('X-Shopify-Access-Token') !== this.adminToken) return j({ errors: 'Invalid API key or access token' }, 401);
      const q = body as { query: string; variables: Record<string, unknown> };
      const node = (c: FakeCustomer) => ({
        id: c.id,
        firstName: c.firstName,
        defaultEmailAddress: { emailAddress: c.email },
        done: c.actionsTaken ? { value: c.actionsTaken } : null,
        votes: c.actionVotes ? { value: c.actionVotes } : null,
      });
      const productNode = (p: FakeProduct) => ({
        id: p.id,
        handle: p.handle,
        title: p.title,
        status: p.status,
        descriptionHtml: p.descriptionHtml,
        description: p.description,
        seo: { description: p.seoDescription ?? null },
        featuredMedia: p.imageUrl ? { preview: { image: { url: p.imageUrl, altText: null } } } : null,
      });
      if (q.query.includes('customers(first: 1, query: $q)')) {
        const email = String(q.variables.q).replace(/^email:"|"$/g, '');
        const m = this.marketing.get(email);
        return j({ data: { customers: { nodes: m ? [{ id: m.id, tags: m.tags, emailMarketingConsent: { marketingState: m.state } }] : [] } } });
      }
      if (q.query.includes('customerCreate')) {
        const input = q.variables.input as { email: string; firstName?: string; tags: string[]; emailMarketingConsent: { marketingState: string } };
        this.marketing.set(input.email, { id: `gid://shopify/Customer/${9000 + this.marketing.size}`, tags: [...input.tags], state: input.emailMarketingConsent.marketingState, firstName: input.firstName });
        return j({ data: { customerCreate: { customer: { id: 'x' }, userErrors: [] } } });
      }
      if (q.query.includes('tagsAdd')) {
        const m = [...this.marketing.values()].find((x) => x.id === q.variables.id);
        m?.tags.push(...(q.variables.tags as string[]));
        return j({ data: { tagsAdd: { userErrors: [] } } });
      }
      if (q.query.includes('customerEmailMarketingConsentUpdate')) {
        const input = q.variables.input as { customerId: string; emailMarketingConsent: { marketingState: string } };
        const m = [...this.marketing.values()].find((x) => x.id === input.customerId);
        if (m) m.state = input.emailMarketingConsent.marketingState;
        return j({ data: { customerEmailMarketingConsentUpdate: { userErrors: [] } } });
      }
      if (q.query.includes('webhookSubscriptionCreate')) {
        const sub = { id: `gid://shopify/WebhookSubscription/${this.webhookSubs.length + 1}`, topic: String(q.variables.topic), uri: String(q.variables.uri) };
        this.webhookSubs.push(sub);
        return j({ data: { webhookSubscriptionCreate: { webhookSubscription: { id: sub.id }, userErrors: [] } } });
      }
      if (q.query.includes('webhookSubscriptions')) return j({ data: { webhookSubscriptions: { nodes: this.webhookSubs } } });
      if (q.query.includes('drop_date')) {
        const nodes = [...this.dropCollections.entries()].map(([handle, c], i) => ({
          id: `gid://shopify/Collection/${500 + i}`,
          handle,
          title: c.title,
          description: c.description || '',
          dropDate: { value: c.dropDate },
          products: { nodes: (this.shopCollections.get(handle) || []).map((id) => ({ id })) },
        }));
        return j({ data: { collections: { nodes } } });
      }
      if (q.query.includes('collections(first: 1')) {
        const handle = String(q.variables.q).replace(/^handle:/, '');
        const ids = this.shopCollections.get(handle);
        if (!ids) return j({ data: { collections: { nodes: [] } } });
        const nodes = ids
          .map((id) => this.products.find((p) => p.id === id))
          .filter(Boolean)
          .map((p) => ({ handle: p!.handle, title: p!.title, status: p!.status, featuredMedia: null, priceRangeV2: { minVariantPrice: { amount: '45.0', currencyCode: 'USD' } }, variants: { nodes: [{ availableForSale: true }] } }));
        return j({ data: { collections: { nodes: [{ products: { nodes } }] } } });
      }
      if (q.query.includes('nodes(ids:')) {
        // A drop's pieces: size and stock of each product asked for.
        const nodes = (q.variables.ids as string[]).map((id) => {
          const p = this.products.find((x) => x.id === id);
          if (!p && !this.inventory.has(id)) return null;
          const inv = this.inventory.get(id);
          return { id, tracksInventory: this.inventory.has(id) && inv !== null, totalInventory: inv ?? 0, edition: p?.editionSize ? { value: String(p.editionSize) } : null };
        });
        return j({ data: { nodes } });
      }
      if (q.query.includes('edition_size')) {
        return j({
          data: {
            products: {
              nodes: this.products
                .filter((p) => p.status === 'ACTIVE')
                .map((p) => ({ id: p.id, handle: p.handle, tracksInventory: this.inventory.get(p.id) !== null && this.inventory.has(p.id), totalInventory: this.inventory.get(p.id) ?? 0, edition: p.editionSize ? { value: String(p.editionSize) } : null })),
            },
          },
        });
      }
      if (q.query.includes('tracksInventory')) {
        const inv = this.inventory.get(String(q.variables.id));
        return j({ data: { product: inv === undefined && !this.inventory.has(String(q.variables.id)) ? null : { tracksInventory: inv !== null, totalInventory: inv ?? 0 } } });
      }
      if (q.query.includes('resourcePublications(')) {
        if (!this.publicationsAllowed) return j({ errors: [{ message: 'Access denied for resourcePublications field. Required access: `read_publications` access scope.' }] });
        const rec = this.published.get(String(q.variables.id));
        // By default a product is on the first channel only.
        const nodes = this.publications.map((id, i) => {
          const date = rec ? rec[id] : i === 0 ? '2026-11-01T00:00:00Z' : null;
          return { isPublished: !!date, publishDate: date ?? null, publication: { id } };
        });
        return j({ data: { product: { resourcePublications: { nodes } } } });
      }
      if (q.query.includes('publishableUnpublish')) {
        const rec = this.published.get(String(q.variables.id)) || {};
        for (const p of q.variables.input as { publicationId: string }[]) rec[p.publicationId] = null;
        this.published.set(String(q.variables.id), rec);
        return j({ data: { publishableUnpublish: { userErrors: [] } } });
      }
      if (q.query.includes('publishablePublish')) {
        const rec = this.published.get(String(q.variables.id)) || {};
        for (const p of q.variables.input as { publicationId: string; publishDate: string }[]) rec[p.publicationId] = p.publishDate;
        this.published.set(String(q.variables.id), rec);
        return j({ data: { publishablePublish: { userErrors: [] } } });
      }
      if (q.query.includes('order(id:')) return j({ data: { order: this.orders.find((o) => o.id === q.variables.id) || null } });
      if (q.query.includes('orders(')) return j({ data: { orders: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: this.orders } } });
      if (q.query.includes('product(id:')) {
        const p = this.products.find((x) => x.id === q.variables.id);
        return j({ data: { product: p ? productNode(p) : null } });
      }
      if (q.query.includes('products(')) {
        return j({ data: { products: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: this.products.filter((p) => p.status === 'ACTIVE').map(productNode) } } });
      }
      if (q.query.includes('customer(id:')) {
        const c = this.customers.find((x) => x.id === q.variables.id);
        return j({ data: { customer: c ? node(c) : null } });
      }
      return j({ data: { customers: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: this.customers.map(node) } } });
    }

    // Webflow Data API v2
    if (url.hostname === 'api.webflow.com') {
      if (headers.get('Authorization') !== 'Bearer wf_test') return j({ message: 'Unauthorized' }, 401);
      if (this.webflowDown) return j({ message: 'Service Unavailable' }, 503);
      const pub = /^\/v2\/collections\/([^/]+)\/items\/publish$/.exec(url.pathname);
      if (pub && method === 'POST') {
        const items = this.collection(pub[1]);
        for (const id of (body as { itemIds: string[] }).itemIds) {
          const it = items.find((i) => i.id === id);
          if (!it) return j({ message: 'not found' }, 404);
          it.live = true;
          it.liveFieldData = { ...it.fieldData };
        }
        return j({ publishedItemIds: (body as { itemIds: string[] }).itemIds }, 202);
      }
      const createLive = /^\/v2\/collections\/([^/]+)\/items\/live$/.exec(url.pathname);
      if (createLive && method === 'POST') {
        const items = this.collection(createLive[1]);
        const b = body as { fieldData: Record<string, unknown> };
        if (items.some((i) => i.fieldData.slug === b.fieldData.slug)) {
          return j({ message: 'Validation Error', details: [{ param: 'slug', description: 'Unique value is already in database' }] }, 400);
        }
        const it: FakeItem = { id: this.newId(), isDraft: false, live: true, fieldData: { ...b.fieldData } };
        it.liveFieldData = { ...it.fieldData };
        items.push(it);
        return j(it, 202);
      }
      const coll = /^\/v2\/collections\/([^/]+)$/.exec(url.pathname);
      if (coll && method === 'GET') {
        if (coll[1] !== CMS.actions.id) return j({ fields: [] });
        return j({
          fields: [
            { slug: 'time', type: 'Reference', validations: { collectionId: 'times' } },
            { slug: 'cost', type: 'Reference', validations: { collectionId: 'costs' } },
          ],
        });
      }
      const m = /^\/v2\/collections\/([^/]+)\/items(?:\/([^/]+))?(?:\/(live))?$/.exec(url.pathname);
      if (!m) return j({ message: 'not found' }, 404);
      const [, cid, rawId, rawLive] = m;
      // /items/live is the live list, not an item called "live".
      const itemId = rawId === 'live' && !rawLive ? undefined : rawId;
      const live = rawId === 'live' && !rawLive ? 'live' : rawLive;
      const items = this.collection(cid);
      if (method === 'GET' && !itemId && live) {
        const all = items.filter((i) => i.live);
        const offset = Number(url.searchParams.get('offset') || 0);
        const limit = Number(url.searchParams.get('limit') || 100);
        return j({ items: all.slice(offset, offset + limit), pagination: { total: all.length, offset, limit } });
      }
      if (method === 'GET' && !itemId) {
        const slug = url.searchParams.get('slug');
        return j({ items: items.filter((i) => !slug || i.fieldData.slug === slug) });
      }
      if (method === 'GET' && itemId && !live) {
        const it = items.find((i) => i.id === itemId);
        return it ? j(it) : j({ message: 'not found' }, 404);
      }
      if (method === 'GET' && itemId && live) {
        const it = items.find((i) => i.id === itemId && i.live);
        return it ? j(it) : j({ message: 'not found' }, 404);
      }
      if (method === 'POST' && !itemId) {
        const b = body as { fieldData: Record<string, unknown>; isDraft: boolean };
        if (items.some((i) => i.fieldData.slug === b.fieldData.slug)) {
          return j({ message: 'Validation Error', details: [{ param: 'slug', description: 'Unique value is already in database' }] }, 400);
        }
        const it: FakeItem = { id: this.newId(), isDraft: b.isDraft, live: false, fieldData: { ...b.fieldData } };
        items.push(it);
        if (this.webflowLoseNextCreateResponse) {
          this.webflowLoseNextCreateResponse = false;
          throw new TypeError('network connection lost');
        }
        return j(it, 202);
      }
      if (method === 'PATCH' && itemId) {
        const it = items.find((i) => i.id === itemId);
        if (!it) return j({ message: 'not found' }, 404);
        const b = body as { fieldData: Record<string, unknown>; isDraft?: boolean };
        Object.assign(it.fieldData, b.fieldData);
        if (typeof b.isDraft === 'boolean') it.isDraft = b.isDraft;
        return j(it);
      }
      if (method === 'DELETE' && itemId && live) {
        const it = items.find((i) => i.id === itemId);
        if (!it || !it.live) return j({ message: 'not found' }, 404);
        it.live = false;
        return new Response(null, { status: 204 });
      }
      if (method === 'DELETE' && itemId) {
        const idx = items.findIndex((i) => i.id === itemId);
        if (idx < 0) return j({ message: 'not found' }, 404);
        items.splice(idx, 1);
        return new Response(null, { status: 204 });
      }
      return j({ message: 'unsupported' }, 400);
    }

    if (url.href === 'https://api.resend.com/emails') {
      if (headers.get('Authorization') !== 'Bearer re_test') return j({ message: 'Unauthorized' }, 401);
      const b = body as { to: string[]; subject?: string; text?: string; template?: { id: string; variables: Record<string, string | number> }; headers?: Record<string, string> };
      if (b.template && (b.subject || b.text)) return j({ message: 'html, text or subject cannot be sent with a template' }, 422);
      this.emails.push({ ...b, subject: b.subject ?? `template:${b.template?.id}`, text: b.text ?? '' });
      return j({ id: `email_${this.emails.length}` });
    }

    if (url.href === 'https://challenges.cloudflare.com/turnstile/v0/siteverify') {
      const b = body as { secret: string; response: string };
      return j({ success: b.secret === 'ts_secret' && b.response === 'human-token' });
    }

    throw new TypeError(`unexpected fetch ${method} ${url.href}`);
  };
}

export interface Harness {
  mf: Miniflare;
  env: Env;
  fake: FakeServices;
  clock: { now: Date; advance(ms: number): void };
  app: ReturnType<typeof createApp>;
  /** Background work started by requests (queue drains, error emails). */
  settle(): Promise<void>;
  request(method: string, path: string, opts?: { token?: string; key?: string | null; body?: unknown; origin?: string | null; headers?: Record<string, string> }): Promise<Response>;
  db<T = Record<string, unknown>>(sql: string, ...params: unknown[]): Promise<T[]>;
}

export async function createHarness(): Promise<Harness> {
  const mf = new Miniflare({
    modules: true,
    script: 'export default { fetch() { return new Response("") } }',
    d1Databases: ['DB'],
    kvNamespaces: ['CACHE'],
    r2Buckets: ['MEDIA'],
  });
  const DB = (await mf.getD1Database('DB')) as unknown as D1Database;
  const dir = new URL('../migrations/', import.meta.url);
  const sql = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(new URL(f, dir), 'utf8'))
    .join(';\n');
  for (const stmt of sql
    .split(/;\s*\n/)
    .map((s) => s.replace(/--.*$/gm, '').trim())
    .filter(Boolean)) {
    await DB.prepare(stmt).run();
  }

  const env: Env = {
    DB,
    CACHE: (await mf.getKVNamespace('CACHE')) as unknown as KVNamespace,
    MEDIA: (await mf.getR2Bucket('MEDIA')) as unknown as R2Bucket,
    ENVIRONMENT: 'test',
    ALLOWED_ORIGINS: `${SITE},https://happiness.foundation`,
    SHOPIFY_STORE_DOMAIN: STORE,
    SHOPIFY_CLIENT_ID: 'shopify_client_id',
    SHOPIFY_CLIENT_SECRET: 'shopify_webhook_secret',
    WEBFLOW_API_TOKEN: 'wf_test',
    RESEND_API_KEY: 're_test',
    MEMBERSTACK_SECRET_KEY: 'sk_sb_test',
    MEMBERSTACK_WEBHOOK_SECRET: 'whsec_' + btoa('memberstack-webhook-secret'),
    EMAIL_FROM: 'Happiness Foundation <team@happiness.foundation>',
    ERROR_EMAIL_TO: 'mickey@example.com',
    TURNSTILE_SECRET_KEY: 'ts_secret',
    JOBS_SECRET: 'jobs_secret',
    ADMIN_SECRET: 'admin_secret',
    LINK_SECRET: 'link_secret',
  };

  const fake = new FakeServices();
  const clock = {
    now: new Date('2026-11-16T09:00:00Z'),
    advance(ms: number) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const app = createApp({ basePath: '/join', deps: { fetch: fake.fetch as typeof fetch, now: () => clock.now } });
  let pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) };

  return {
    mf,
    env,
    fake,
    clock,
    app,
    async settle() {
      while (pending.length) {
        const batch = pending;
        pending = [];
        await Promise.allSettled(batch);
      }
    },
    async request(method, path, opts = {}) {
      const headers: Record<string, string> = { ...(opts.headers || {}) };
      if (opts.origin !== null) headers.Origin = opts.origin ?? SITE;
      if (opts.token) headers.Authorization = `Bearer ${opts.token}`;
      if (opts.key !== null && method !== 'GET') headers['Idempotency-Key'] = opts.key ?? crypto.randomUUID();
      if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
      return app.handle(
        new Request(`${SITE}/join${path}`, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) }),
        env,
        ctx,
      );
    },
    async db(q, ...params) {
      const r = await DB.prepare(q)
        .bind(...params)
        .all();
      return r.results as never;
    },
  };
}
