// Test harness: real SQLite (D1), key-value (KV) and object storage (R2)
// from Miniflare, the same runtime Webflow Cloud uses, with fake Shopify,
// Webflow, Resend and Turnstile services behind an injected fetch.

import { readFileSync } from 'node:fs';
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
  actionsTaken?: string; // raw metafield JSON
  actionVotes?: string;
}

export interface FakeItem {
  id: string;
  isDraft: boolean;
  live: boolean;
  fieldData: Record<string, unknown>;
}

export class FakeServices {
  /** token -> customer */
  tokens = new Map<string, FakeCustomer>();
  customers: FakeCustomer[] = [];
  /** collectionId -> items */
  items = new Map<string, FakeItem[]>();
  emails: { to: string[]; subject: string; text: string; headers?: Record<string, string> }[] = [];
  calls: { method: string; url: string; body?: unknown }[] = [];
  webflowDown = false;
  /** Webflow creates the item but the answer is lost (network drop). */
  webflowLoseNextCreateResponse = false;
  shopifyDown = false;
  private seq = 0;

  newId(): string {
    this.seq++;
    return (Date.now().toString(16) + this.seq.toString(16)).padStart(24, 'a').slice(-24);
  }

  collection(id: string): FakeItem[] {
    if (!this.items.has(id)) this.items.set(id, []);
    return this.items.get(id)!;
  }

  addAction(slug: string, name: string, doItWith: string[] = [CMS.actions.onMyOwnCompanionId]): string {
    const id = this.newId();
    this.collection(CMS.actions.id).push({ id, isDraft: false, live: true, fieldData: { name, slug, 'short-answer': `Do ${name}`, 'do-it-with': doItWith } });
    return id;
  }

  signIn(token: string, c: Partial<FakeCustomer> = {}): FakeCustomer {
    const customer: FakeCustomer = { id: c.id || `gid://shopify/Customer/${1000 + this.tokens.size}`, firstName: c.firstName ?? 'Ana', email: c.email ?? `${token}@example.com`, ...c };
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
    if (url.href === CUSTOMER_API) {
      if (this.shopifyDown) return j({ errors: 'down' }, 503);
      const c = this.tokens.get(headers.get('Authorization') || '');
      if (!c) return j({ errors: [{ message: 'Unauthorized' }] }, 401);
      return j({ data: { customer: { id: c.id, firstName: c.firstName, emailAddress: c.email ? { emailAddress: c.email } : null } } });
    }

    // Shopify Admin API
    if (url.hostname === STORE && url.pathname.startsWith('/admin/api/')) {
      if (headers.get('X-Shopify-Access-Token') !== 'shpat_test') return j({ errors: 'Unauthorized' }, 401);
      const q = body as { query: string; variables: Record<string, unknown> };
      const node = (c: FakeCustomer) => ({
        id: c.id,
        firstName: c.firstName,
        defaultEmailAddress: { emailAddress: c.email },
        done: c.actionsTaken ? { value: c.actionsTaken } : null,
        votes: c.actionVotes ? { value: c.actionVotes } : null,
      });
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
        Object.assign(it.fieldData, (body as { fieldData: Record<string, unknown> }).fieldData);
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
      const b = body as { to: string[]; subject: string; text: string; headers?: Record<string, string> };
      this.emails.push(b);
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
  const sql = readFileSync(new URL('../migrations/0001_init.sql', import.meta.url), 'utf8');
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
    SHOPIFY_ADMIN_TOKEN: 'shpat_test',
    SHOPIFY_WEBHOOK_SECRET: 'shopify_webhook_secret',
    WEBFLOW_API_TOKEN: 'wf_test',
    RESEND_API_KEY: 're_test',
    EMAIL_FROM: 'Happiness Foundation <hello@happiness.foundation>',
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
