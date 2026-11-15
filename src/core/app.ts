import { allowedOrigins, defaultDeps, missingEnv, type Ctx, type Deps, type Env } from './env';
import { reportError } from './errors';
import { verifyUnsubscribe } from './email';
import { EMAIL_KINDS } from './config';
import { HttpError, UpstreamError, base64url, errorResponse, hmac, iso, json, readJson, requireSecret, timingSafeEqual } from './http';
import { optionalMember, requireMember, type Member } from './identity';
import { drain } from './queue';
import { checkOrigin, idempotencyKey, once, requireHuman } from './safety';
import { actionState, markDone, resolveActionRef, setLike, syncActions } from './features/actions';
import { deleteMemberByCustomerId, deleteMemberData, getAccount, updateSettings } from './features/account';
import { completeIntent, createIntent, readIntent } from './features/intents';
import { runImport } from './features/importer';
import { ensureShopifyWebhooks, syncAllProducts, syncOneProduct } from './features/products';
import { deleteStory, sendStory, sendSuggestion } from './features/submissions';
import { customerGid } from './shopify';

type Params = Record<string, string>;
interface Call {
  req: Request;
  env: Env;
  deps: Deps;
  ctx: Ctx;
  params: Params;
  baseUrl: string;
}
type Handler = (c: Call) => Promise<Response>;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  /** Browser calls from the site: origin check and CORS. */
  site: boolean;
  handler: Handler;
}

const routes: Route[] = [];
function route(method: string, path: string, site: boolean, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([a-zA-Z]+)/g, (_, k) => {
        keys.push(k);
        return '([^/]+)';
      }) +
      '/?$',
  );
  routes.push({ method, pattern, keys, site, handler });
}

/** A member write: verified sign-in, then run once per one-time key. */
function memberWrite(name: string, fn: (c: Call, member: Member) => Promise<unknown>, status = 200): Handler {
  return async (c) => {
    const member = await requireMember(c.req, c.env, c.deps);
    const key = idempotencyKey(c.req);
    const res = await once(c.env, c.deps, `m:${member.id}`, key, name, async () => json(await fn(c, member), status));
    // Push queued writes out now; the scheduled job is the safety net.
    c.ctx.waitUntil(drain(c.env, c.deps, { limit: 5, deadlineMs: 10_000 }).catch((e) => reportError(c.env, c.deps, { where: 'drain after write', error: e })));
    return res;
  };
}

// --- Site calls -------------------------------------------------------------

route('GET', '/api/health', false, async ({ env }) => {
  const missing = missingEnv(env);
  return json({ ok: missing.length === 0, environment: env.ENVIRONMENT || null, missing });
});

route('GET', '/api/actions/:id/state', true, async ({ req, env, deps, params }) => {
  const id = await resolveActionRef(env, deps, params.id);
  const member = await optionalMember(req, env, deps);
  return json(await actionState(env, deps, id, member));
});

route('POST', '/api/actions/:id/done', true, memberWrite('done', async ({ env, deps, params }, m) => markDone(env, deps, m, await resolveActionRef(env, deps, params.id)), 201));

route(
  'PUT',
  '/api/actions/:id/like',
  true,
  memberWrite('like', async ({ req, env, deps, params }, m) => {
    const body = await readJson<{ liked?: unknown }>(req);
    if (typeof body.liked !== 'boolean') throw new HttpError(400, 'invalid_like', 'That could not be saved.');
    return setLike(env, deps, m, await resolveActionRef(env, deps, params.id), body.liked);
  }),
);

route(
  'POST',
  '/api/suggestions',
  true,
  memberWrite('suggestion', async ({ req, env, deps }, m) => sendSuggestion(env, deps, m, await readJson(req)), 201),
);

route('POST', '/api/stories', true, memberWrite('story', async ({ req, env, deps }, m) => sendStory(env, deps, m, await readJson(req)), 201));

route(
  'DELETE',
  '/api/stories/:id',
  true,
  memberWrite('story-delete', ({ env, deps, params }, m) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'story_not_found', 'That story could not be found.');
    return deleteStory(env, deps, m, id);
  }),
);

route('GET', '/api/me', true, async ({ req, env, deps }) => json(await getAccount(env, await requireMember(req, env, deps))));

route('PATCH', '/api/me/settings', true, memberWrite('settings', async ({ req, env, deps }, m) => updateSettings(env, deps, m, await readJson(req))));

route(
  'DELETE',
  '/api/me',
  true,
  memberWrite('delete-me', async ({ env, deps }, m) => ({ deleted: true, ...(await deleteMemberData(env, deps, m.id)) })),
);

// Resume after sign-in.
route('POST', '/api/intents', true, async ({ req, env, deps }) => {
  const body = await readJson(req);
  await requireHuman(req, env, deps, body.turnstileToken);
  return json(await createIntent(env, deps, body, allowedOrigins(env)), 201);
});

route('GET', '/api/intents/:id', true, async ({ env, params }) => {
  const intent = await readIntent(env, params.id);
  if (!intent) throw new HttpError(404, 'intent_expired', 'That was saved too long ago. Please try again.');
  return json(intent);
});

route('POST', '/api/intents/:id/complete', true, async (c) => {
  const member = await requireMember(c.req, c.env, c.deps);
  const id = c.params.id;
  // The intent ID is the one-time key: completing it twice does it once.
  const res = await once(c.env, c.deps, `m:${member.id}`, `intent-${id}`, 'intent', async () => json(await completeIntent(c.env, c.deps, member, id)));
  c.ctx.waitUntil(drain(c.env, c.deps, { limit: 5, deadlineMs: 10_000 }).catch(() => undefined));
  return res;
});

// --- Email links ------------------------------------------------------------

async function unsubscribe({ req, env, deps }: Call): Promise<Response> {
  const token = new URL(req.url).searchParams.get('t') || '';
  const parsed = await verifyUnsubscribe(env, token);
  if (!parsed) return new Response('This link is not valid.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  await env.DB.prepare(`UPDATE members SET ${EMAIL_KINDS[parsed.kind]} = 0, updated_at = ?2 WHERE id = ?1`).bind(parsed.memberId, iso(deps.now())).run();
  return new Response('You will not get these emails any more. You can turn them back on from your account page.', {
    status: 200,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}
route('GET', '/api/notifications/off', false, unsubscribe);
route('POST', '/api/notifications/off', false, unsubscribe);

// --- Scheduled jobs and admin -----------------------------------------------

route('POST', '/api/jobs/tick', false, async ({ req, env, deps, baseUrl }) => {
  requireSecret(req, env.JOBS_SECRET);
  const out: Record<string, unknown> = { queue: await drain(env, deps, { limit: 60, deadlineMs: 25_000 }) };
  // Hourly jobs. Each runs at most once an hour, whatever the timer does.
  const HOUR = 60 * 60 * 1000;
  const jobs: [string, string, number, () => Promise<unknown>][] = [
    ['sync-actions', 'syncActions', HOUR, () => syncActions(env, deps)],
    ['sync-products', 'syncProducts', HOUR, () => syncAllProducts(env, deps)],
    // Keeps Shopify's product and customer-deletion webhooks pointed here.
    ['shopify-webhooks', 'shopifyWebhooks', 24 * HOUR, () => ensureShopifyWebhooks(env, deps, `${baseUrl}/api/webhooks/shopify`)],
  ];
  for (const [job, key, every, run] of jobs) {
    const last = await env.DB.prepare(`SELECT last_run_at FROM job_runs WHERE job = ?1`).bind(job).first<{ last_run_at: string }>();
    if (last && deps.now().getTime() - Date.parse(last.last_run_at) <= every) continue;
    try {
      const result = await run();
      out[key] = result;
      const errs = (result as { errors?: unknown[] }).errors;
      if (errs?.length) await reportError(env, deps, { where: `job ${job}`, error: new Error(`${errs.length} item(s) failed`), details: { errors: errs } });
      await env.DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES (?1, ?2) ON CONFLICT (job) DO UPDATE SET last_run_at = excluded.last_run_at`)
        .bind(job, iso(deps.now()))
        .run();
    } catch (e) {
      out[key] = { error: (e as Error).message };
      await reportError(env, deps, { where: `job ${job}`, error: e });
    }
  }
  out.importMetafields = await importJob(env, deps);
  return json(out);
});

route('POST', '/api/admin/sync-actions', false, async ({ req, env, deps }) => {
  requireSecret(req, env.ADMIN_SECRET);
  return json(await syncActions(env, deps));
});

route('POST', '/api/admin/sync-products', false, async ({ req, env, deps }) => {
  requireSecret(req, env.ADMIN_SECRET);
  return json(await syncAllProducts(env, deps));
});

route('POST', '/api/admin/shopify-webhooks', false, async ({ req, env, deps, baseUrl }) => {
  requireSecret(req, env.ADMIN_SECRET);
  return json(await ensureShopifyWebhooks(env, deps, `${baseUrl}/api/webhooks/shopify`));
});

route('POST', '/api/admin/import', false, async ({ req, env, deps }) => {
  requireSecret(req, env.ADMIN_SECRET);
  const body = await readJson<{ cursor?: string; customerId?: string }>(req);
  return json(await runImport(env, deps, { cursor: body.cursor ?? null, customerId: body.customerId ?? null }));
});

// One-time import of done actions and likes from Shopify metafields, run by
// the jobs timer: a full pass now, and one more a day later to catch anything
// written by pages that were still open during the switch. Safe to repeat.
const IMPORT_PASSES = 2;
async function importJob(env: Env, deps: Deps): Promise<unknown> {
  const state = ((await env.CACHE.get('import:state', 'json')) as { passes: number; cursor: string | null; lastFinished: string | null } | null) || {
    passes: 0,
    cursor: null,
    lastFinished: null,
  };
  if (state.passes >= IMPORT_PASSES) return undefined;
  if (!state.cursor && state.lastFinished && deps.now().getTime() - Date.parse(state.lastFinished) < 24 * 60 * 60 * 1000) return undefined;
  const totals = { customers: 0, marksAdded: 0, likesAdded: 0, unmatched: [] as unknown[], invalid: [] as unknown[] };
  const started = Date.now();
  try {
    do {
      const r = await runImport(env, deps, { cursor: state.cursor });
      totals.customers += r.customers;
      totals.marksAdded += r.marksAdded;
      totals.likesAdded += r.likesAdded;
      totals.unmatched.push(...r.unmatched);
      totals.invalid.push(...r.invalid);
      state.cursor = r.nextCursor;
    } while (state.cursor && Date.now() - started < 15_000);
    if (!state.cursor) {
      state.passes++;
      state.lastFinished = iso(deps.now());
      if (totals.unmatched.length || totals.invalid.length) {
        await reportError(env, deps, {
          where: 'import metafields',
          error: new Error(`${totals.unmatched.length} unmatched slug(s), ${totals.invalid.length} invalid record(s)`),
          details: { unmatched: totals.unmatched.slice(0, 50), invalid: totals.invalid.slice(0, 50) },
        });
      }
    }
    await env.CACHE.put('import:state', JSON.stringify(state));
    return { pass: state.passes, finished: !state.cursor, ...totals, unmatched: totals.unmatched.length, invalid: totals.invalid.length };
  } catch (e) {
    await reportError(env, deps, { where: 'import metafields', error: e });
    return { error: (e as Error).message };
  }
}

// --- Incoming webhooks ------------------------------------------------------

route('POST', '/api/webhooks/shopify', false, async ({ req, env, deps }) => {
  const raw = new Uint8Array(await req.arrayBuffer());
  const given = req.headers.get('X-Shopify-Hmac-Sha256') || '';
  const expected = btoa(String.fromCharCode(...(await hmac(env.SHOPIFY_CLIENT_SECRET, raw))));
  if (!env.SHOPIFY_CLIENT_SECRET || !timingSafeEqual(given, expected)) throw new HttpError(401, 'unauthorized', 'Not authorised.');
  const topic = req.headers.get('X-Shopify-Topic') || '';
  const webhookId = req.headers.get('X-Shopify-Webhook-Id') || base64url(await hmac('id', raw));
  let body: Record<string, unknown> = {};
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Invalid body.');
  }
  return once(env, deps, 'shopify-webhook', webhookId.slice(0, 128).replace(/[^A-Za-z0-9_.:-]/g, '-').padEnd(8, '-'), topic || 'unknown', async () => {
    if (topic === 'customers/delete' || topic === 'customers/redact') {
      const id = topic === 'customers/delete' ? body.id : (body.customer as { id?: unknown } | undefined)?.id;
      const deleted = id ? await deleteMemberByCustomerId(env, deps, customerGid(String(id))) : false;
      return json({ ok: true, deleted });
    }
    if (topic === 'products/create' || topic === 'products/update' || topic === 'products/delete') {
      if (!body.id) return json({ ok: true, ignored: 'no product id' });
      return json({ ok: true, ...(await syncOneProduct(env, deps, String(body.id), topic === 'products/delete')) });
    }
    // Order webhooks arrive in Phase 3.
    return json({ ok: true, ignored: topic });
  });
});

// --- Request handling -------------------------------------------------------

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get('Origin');
  if (!origin || !allowedOrigins(env).has(origin)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'false',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, CF-Turnstile-Response',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function withHeaders(res: Response, headers: Record<string, string>): Response {
  if (!Object.keys(headers).length) return res;
  const out = new Response(res.body, res);
  for (const [k, v] of Object.entries(headers)) out.headers.set(k, v);
  return out;
}

export interface AppOptions {
  /** Mount path, e.g. "/join". Webflow Cloud passes it as BASE_URL. */
  basePath?: string;
  deps?: Partial<Deps>;
}

export function createApp(opts: AppOptions = {}) {
  const base = (opts.basePath ?? '/join').replace(/\/+$/, '');
  const deps: Deps = { ...defaultDeps(), ...opts.deps };

  async function handle(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    let path = url.pathname;
    if (base && path.startsWith(base)) path = path.slice(base.length) || '/';
    const baseUrl = `${url.origin}${base}`;

    const match = routes
      .map((r) => ({ r, m: r.pattern.exec(path) }))
      .filter((x) => x.m);
    const cors = corsHeaders(req, env);

    if (req.method === 'OPTIONS' && match.some((x) => x.r.site)) {
      return new Response(null, { status: Object.keys(cors).length ? 204 : 403, headers: cors });
    }
    const found = match.find((x) => x.r.method === req.method);
    if (!found) {
      return match.length
        ? json({ error: 'method_not_allowed', message: 'Not allowed.' }, 405)
        : json({ error: 'not_found', message: 'Not found.' }, 404);
    }

    try {
      const missing = missingEnv(env);
      if (missing.length && path !== '/api/health') {
        throw new Error(`Backend is missing configuration: ${missing.join(', ')}`);
      }
      if (found.r.site) checkOrigin(req, allowedOrigins(env));
      const params: Params = {};
      found.r.keys.forEach((k, i) => (params[k] = decodeURIComponent(found.m![i + 1])));
      const res = await found.r.handler({ req, env, deps, ctx, params, baseUrl });
      return withHeaders(res, found.r.site ? cors : {});
    } catch (e) {
      if (e instanceof HttpError) return withHeaders(errorResponse(e), found.r.site ? cors : {});
      if (e instanceof UpstreamError) {
        ctx.waitUntil(reportError(env, deps, { where: `${req.method} ${path}`, error: e, details: { service: e.service, status: e.status } }));
        return withHeaders(
          json({ error: 'service_unavailable', message: 'We could not finish this right now. Please try again in a moment.' }, 503, { 'Retry-After': '5' }),
          found.r.site ? cors : {},
        );
      }
      ctx.waitUntil(reportError(env, deps, { where: `${req.method} ${path}`, error: e, details: { url: `${url.origin}${url.pathname}` } }));
      return withHeaders(json({ error: 'server_error', message: 'Something went wrong. Please try again.' }, 500), found.r.site ? cors : {});
    }
  }

  return { handle, deps };
}
