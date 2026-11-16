import { allowedOrigins, defaultDeps, missingEnv, type Ctx, type Deps, type Env } from './env';
import { reportError } from './errors';
import { verifyUnsubscribe } from './email';
import { EMAIL_KINDS } from './config';
import { HttpError, UpstreamError, base64url, errorResponse, hmac, iso, json, readJson, requireSecret, timingSafeEqual } from './http';
import { optionalMember, requireMember, type Member } from './identity';
import { drain } from './queue';
import { checkOrigin, idempotencyKey, once, requireHuman } from './safety';
import { actionState, markDone, mostDone, resolveActionRef, setLike, syncActions, undoDone, writeCountsToCms } from './features/actions';
import { deleteMemberByCustomerId, deleteMemberData, getAccount, updateSettings } from './features/account';
import { completeIntent, createIntent, readIntent } from './features/intents';
import { runImport } from './features/importer';
import { ensureShopifyWebhooks, syncAllProducts, syncOneProduct } from './features/products';
import { dropState, forgetShop, productLabels, scheduleDropReleases, shopCatalog, shopDrops, signUpForDrop, updateDropsInCms, warmShop } from './features/drops';
import { ingestOrder, orderFromWebhook, pledgeReminders, refundOrder, syncRecentOrders } from './features/pledges';
import { labDecide, reviewAll, reviewQueue } from './features/review';
import { myStory, reportStory, saveStory, servePhoto, storiesFor, uploadPhoto } from './features/stories';
import { createInvite, getInvite, invitePreview, inviteSummaries, isInviteCode, joinInvite, leaveInvite } from './features/ripple';
import { addLabAccess, assertLabAccess, backupDatabase, handleWebflowWebhook, labKpis, listLabAccess, removeLabAccess } from './features/ops';
import { deleteStory, sendSuggestion } from './features/submissions';
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

route('DELETE', '/api/actions/:id/done', true, memberWrite('undo', async ({ env, deps, params }, m) => undoDone(env, deps, m, await resolveActionRef(env, deps, params.id))));

route('GET', '/api/most-done', true, async ({ env }) => json(await mostDone(env), 200, { 'Cache-Control': 'public, max-age=60' }));

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

// Stories: send or edit, the member's own story, photos, the public list, reports.
route(
  'POST',
  '/api/stories',
  true,
  memberWrite(
    'story',
    async ({ req, env, deps, baseUrl }, m) => {
      const body = await readJson<Record<string, unknown>>(req);
      if (typeof body.actionId === 'string') body.actionId = await resolveActionRef(env, deps, body.actionId);
      return saveStory(env, deps, m, body, baseUrl);
    },
    201,
  ),
);

route('GET', '/api/stories/mine', true, async ({ req, env, deps }) => {
  const member = await requireMember(req, env, deps);
  const ref = new URL(req.url).searchParams.get('action') || '';
  return json(await myStory(env, member, await resolveActionRef(env, deps, ref)));
});

route('POST', '/api/stories/photo', true, async ({ req, env, deps }) => json(await uploadPhoto(env, deps, await requireMember(req, env, deps), req), 201));

route('GET', '/api/stories', true, async ({ req, env }) => {
  const u = new URL(req.url);
  const page = Math.max(1, Number(u.searchParams.get('page') || '1') || 1);
  return json({ page, stories: await storiesFor(env, { limit: 20, offset: (page - 1) * 20 }) }, 200, { 'Cache-Control': 'public, max-age=60' });
});

route('POST', '/api/stories/:id/report', true, async ({ req, env, deps, params, ctx }) => {
  const body = await readJson<{ reason?: unknown; turnstileToken?: unknown }>(req);
  await requireHuman(req, env, deps, body.turnstileToken);
  const out = await reportStory(env, deps, Number(params.id), body.reason);
  ctx.waitUntil(drain(env, deps, { limit: 3, deadlineMs: 10_000 }).catch(() => undefined));
  return json(out);
});

route('GET', '/media/stories/:key', false, async ({ env, params }) => servePhoto(env, `stories/${params.key}`));

// Drops: the hero's live state (status, stock, pledges).
route('GET', '/api/drops/state', true, async ({ req, env, deps }) => {
  const slug = new URL(req.url).searchParams.get('drop');
  return json(await dropState(env, deps, slug && /^[a-z0-9-]{1,100}$/.test(slug) ? slug : null), 200, { 'Cache-Control': 'public, max-age=30' });
});

route('GET', '/api/products/labels', true, async ({ env, deps }) => json({ labels: await productLabels(env, deps) }, 200, { 'Cache-Control': 'public, max-age=30' }));

route('GET', '/api/shop', true, async ({ env, deps, ctx }) => json(await shopCatalog(env, deps, (p) => ctx.waitUntil(p)), 200, { 'Cache-Control': 'public, max-age=30' }));

route('GET', '/api/drops', true, async ({ env, deps }) => json(await shopDrops(env, deps), 200, { 'Cache-Control': 'public, max-age=30' }));

// Ripple: invites and "I'm in".
route('POST', '/api/invites', true, memberWrite('invite', async ({ req, env, deps, baseUrl }, m) => {
  const body = await readJson<{ actionId?: unknown; kind?: unknown; note?: unknown }>(req);
  if (typeof body.actionId === 'string') body.actionId = await resolveActionRef(env, deps, body.actionId);
  return createInvite(env, deps, m, body, baseUrl);
}, 201));

route('GET', '/api/invites/:code', true, async ({ req, env, deps, params }) => json(await getInvite(env, deps, params.code, await optionalMember(req, env, deps))));

route('POST', '/api/invites/:code/join', true, memberWrite('invite-join', async ({ env, deps, params }, m) => joinInvite(env, deps, m, params.code)));

route('DELETE', '/api/invites/:code/join', true, memberWrite('invite-leave', async ({ env, deps, params }, m) => leaveInvite(env, deps, m, params.code)));

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

// "Notify me when this drop goes live". Signed in: the account's email is
// used. Signed out: the visitor types an email and passes the bot check.
route('POST', '/api/drops/notify', true, async ({ req, env, deps, ctx }) => {
  const body = await readJson<{ drop?: unknown; email?: unknown; turnstileToken?: unknown }>(req);
  const member = await optionalMember(req, env, deps);
  if (!member) await requireHuman(req, env, deps, body.turnstileToken);
  const result = await signUpForDrop(env, deps, body, member);
  ctx.waitUntil(drain(env, deps, { limit: 3, deadlineMs: 10_000 }).catch(() => undefined));
  return json(result, 201);
});

// KPIs for the /lab dashboard page.
route('GET', '/api/lab/kpis', true, async ({ req, env, deps }) => {
  const member = await requireMember(req, env, deps);
  const me = await assertLabAccess(env, member);
  return json({ ...(await labKpis(env, deps)), me });
});

// Who can see /lab: anyone with access can add or remove invited people.
route('GET', '/api/lab/access', true, async ({ req, env, deps }) => {
  await assertLabAccess(env, await requireMember(req, env, deps));
  return json(await listLabAccess(env));
});
route('POST', '/api/lab/access', true, async ({ req, env, deps, ctx, baseUrl }) => {
  const me = await assertLabAccess(env, await requireMember(req, env, deps));
  const out = await addLabAccess(env, deps, me.email, await readJson(req), baseUrl);
  ctx.waitUntil(drain(env, deps, { limit: 3, deadlineMs: 10_000 }).catch(() => undefined));
  return json(out);
});
route('DELETE', '/api/lab/access', true, async ({ req, env, deps }) => {
  await assertLabAccess(env, await requireMember(req, env, deps));
  return json(await removeLabAccess(env, await readJson(req)));
});

// Reviewing stories and suggestions from /lab.
route('GET', '/api/lab/review', true, async ({ req, env, deps }) => {
  await assertLabAccess(env, await requireMember(req, env, deps));
  return json(await reviewQueue(env));
});
route('POST', '/api/lab/review', true, async ({ req, env, deps, ctx, baseUrl }) => {
  const me = await assertLabAccess(env, await requireMember(req, env, deps));
  const out = await labDecide(env, deps, me.email, await readJson(req), baseUrl);
  ctx.waitUntil(drain(env, deps, { limit: 5, deadlineMs: 10_000 }).catch(() => undefined));
  return json(out);
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
    ['backup', 'backup', 24 * HOUR, () => backupDatabase(env, deps)],
    // Phase 2: review in the CMS (the Webflow webhook is the fast path).
    ['review', 'review', 15 * 60 * 1000, () => reviewAll(env, deps, baseUrl)],
    // Phase 3: drops, counts and pledges.
    ['drops', 'drops', 0, () => updateDropsInCms(env, deps)],
    ['warm-shop', 'warmShop', 0, () => warmShop(env, deps)],
    ['drop-releases', 'dropReleases', HOUR, () => scheduleDropReleases(env, deps)],
    ['write-counts', 'writeCounts', HOUR, () => writeCountsToCms(env, deps)],
    ['sync-orders', 'syncOrders', 6 * HOUR, () => syncRecentOrders(env, deps, { days: 3 })],
    ['pledge-reminders', 'pledgeReminders', HOUR, () => pledgeReminders(env, deps, baseUrl)],
    // Phase 4: one summary email a day per inviter.
    ['invite-summaries', 'inviteSummaries', 24 * HOUR, () => inviteSummaries(env, deps, baseUrl)],
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

// The shared invite link: /join/<code>. Registered last so it never shadows other routes.
route('GET', '/:code', false, async ({ env, deps, params, baseUrl }) => {
  if (!isInviteCode(params.code)) return json({ error: 'not_found', message: 'Not found.' }, 404);
  return invitePreview(env, deps, params.code, baseUrl);
});
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

route('POST', '/api/webhooks/webflow', false, async ({ req, env, deps, baseUrl, ctx }) => {
  const body = await readJson(req);
  const out = await handleWebflowWebhook(env, deps, body, baseUrl);
  ctx.waitUntil(drain(env, deps, { limit: 5, deadlineMs: 10_000 }).catch(() => undefined));
  return json(out);
});

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
      await forgetShop(env);
      return json({ ok: true, ...(await syncOneProduct(env, deps, String(body.id), topic === 'products/delete')) });
    }
    if (topic === 'orders/create' || topic === 'orders/updated' || topic === 'orders/cancelled' || topic === 'orders/paid') {
      const order = orderFromWebhook(body);
      return json({ ok: true, ...(order ? await ingestOrder(env, deps, order) : { ignored: 'no order' }) });
    }
    if (topic === 'refunds/create') return json({ ok: true, ...(await refundOrder(env, deps, body.order_id)) });
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
