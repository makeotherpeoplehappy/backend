import { allowedOrigins, defaultDeps, missingEnv, type Ctx, type Deps, type Env } from './env';
import { reportError } from './errors';
import { verifyUnsubscribe } from './email';
import { WORDING, WORDING_SCRIPT, word } from './wording';
import { EMAIL_KINDS } from './config';
import { HttpError, UpstreamError, base64url, errorResponse, hmac, iso, json, readJson, requireSecret, timingSafeEqual } from './http';
import { optionalMember, requireMember, type Member } from './identity';
import { currentDare } from './features/dare';
import { claimGuest, expireGuests, guestFromRequest, memberOrGuest } from './features/guests';
import { drain } from './queue';
import { checkOrigin, idempotencyKey, once, requireHuman } from './safety';
import { recentActivity } from './features/activity';
import { refreshAllActive } from './features/active';
import { actionState, markDone, mostDone, resolveActionRef, setLike, setMarkPeople, syncActions, undoDone, writeCountsToCms } from './features/actions';
import { deleteMemberByCustomerId, deleteMemberData, getAccount, updateSettings } from './features/account';
import { completeIntent, createIntent, readIntent } from './features/intents';
import { runImport } from './features/importer';
import { ensureShopifyWebhooks } from './features/products';
import { dropState, forgetDrops, scheduleDropReleases, shopDrops } from './features/drops';
import { dropNotifications, productState, queueShopSync, setNotify, startCheckout, syncShop } from './features/shop';
import { ingestOrder, orderFromWebhook, pledgeReminders, refundOrder, syncRecentOrders } from './features/pledges';
import { labDecide, reviewAll, reviewQueue } from './features/review';
import { myStory, reportStory, saveStory, servePhoto, storiesFor, uploadPhoto } from './features/stories';
import { completeVideo, serveVideo, startVideo, uploadVideoPart } from './features/videos';
import { createInvite, getInvite, invitePreview, inviteSummaries, isInviteCode, joinInvite, leaveInvite } from './features/ripple';
import { addLabAccess, assertLabAccess, backupDatabase, handleWebflowWebhook, labFailedWrite, labKpis, listLabAccess, publicImpact, removeLabAccess } from './features/ops';
import { deleteStory, sendSuggestion } from './features/submissions';
import { logOwnAction, matchActions } from './features/own';
import { memberstackWebhook } from './features/memberstack';
import { claimEmails, claimPledges } from './features/claims';
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

/** Like memberWrite, but a visitor without an account acts as their guest (made on the first "I did this"). */
function doerWrite(name: string, create: boolean, fn: (c: Call, member: Member) => Promise<unknown>, status = 200): Handler {
  return async (c) => {
    const member = await memberOrGuest(c.req, c.env, c.deps, create);
    if (!member) throw new HttpError(401, 'signin_required', 'err-signin-required');
    const key = idempotencyKey(c.req);
    const res = await once(c.env, c.deps, `m:${member.id}`, key, name, async () => json(await fn(c, member), status));
    c.ctx.waitUntil(drain(c.env, c.deps, { limit: 5, deadlineMs: 10_000 }).catch((e) => reportError(c.env, c.deps, { where: 'drain after write', error: e })));
    return res;
  };
}

// --- Site calls -------------------------------------------------------------

// The interface text for the page scripts (src/wording/en.json), loaded before them.
// It only changes with a deploy, so it carries an ETag: a returning visitor gets a
// tiny 304 instead of the whole text (Webflow Cloud makes every response no-cache).
const WORDING_ETAG = `"w${fnv1a(WORDING_SCRIPT)}"`;
route('GET', '/hf-wording.js', false, async ({ req }) => {
  const headers = { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=300', ETag: WORDING_ETAG };
  const seen = req.headers.get('If-None-Match') || '';
  if (seen.split(',').some((t) => t.trim().replace(/^W\//, '') === WORDING_ETAG)) return new Response(null, { status: 304, headers });
  return new Response(WORDING_SCRIPT, { headers });
});
/** A short, stable fingerprint of a text (FNV-1a, 32 bit). */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

route('GET', '/api/health', false, async ({ env }) => {
  const missing = missingEnv(env);
  return json({ ok: missing.length === 0, environment: env.ENVIRONMENT || null, missing });
});

route('GET', '/api/actions/:id/state', true, async ({ req, env, deps, params }) => {
  const id = await resolveActionRef(env, deps, params.id);
  const member = (await optionalMember(req, env, deps)) || (await guestFromRequest(req, env, deps, false));
  return json(await actionState(env, deps, id, member));
});

// "I did this" and undo also work without an account (try before sign-up).
route('POST', '/api/actions/:id/done', true, doerWrite('done', true, async ({ req, env, deps, params }, m) => markDone(env, deps, m, await resolveActionRef(env, deps, params.id), req.headers.get('X-HF-Ref')), 201));

// After "I did this": how many people it made happy (one, few or more), on the latest mark.
route(
  'PATCH',
  '/api/actions/:id/done',
  true,
  doerWrite('people', false, async ({ req, env, deps, params }, m) => {
    const body = await readJson<{ people?: unknown }>(req);
    return setMarkPeople(env, m, await resolveActionRef(env, deps, params.id), body.people);
  }),
);

route('DELETE', '/api/actions/:id/done', true, doerWrite('undo', false, async ({ env, deps, params }, m) => undoDone(env, deps, m, await resolveActionRef(env, deps, params.id))));

// After sign-in: the marks made on this device before it move to the account.
route('POST', '/api/me/claim-guest', true, async ({ req, env, deps }) => {
  const member = await requireMember(req, env, deps);
  return json(await claimGuest(env, deps, member, await guestFromRequest(req, env, deps, false)));
});

route('GET', '/api/impact', true, async ({ env }) => json(await publicImpact(env), 200, { 'Cache-Control': 'public, max-age=300' }));
// Weekly dare: this week's action and how many people took it (from 10 up).
route('GET', '/api/dare', true, async ({ env, deps }) => json(await currentDare(env, deps), 200, { 'Cache-Control': 'public, max-age=30' }));
route('GET', '/api/activity', true, async ({ env, deps }) => json(await recentActivity(env, deps), 200, { 'Cache-Control': 'public, max-age=30' }));
route('GET', '/api/most-done', true, async ({ env }) => json(await mostDone(env), 200, { 'Cache-Control': 'public, max-age=60' }));

route(
  'PUT',
  '/api/actions/:id/like',
  true,
  memberWrite('like', async ({ req, env, deps, params }, m) => {
    const body = await readJson<{ liked?: unknown }>(req);
    if (typeof body.liked !== 'boolean') throw new HttpError(400, 'invalid_like', 'err-invalid-like');
    return setLike(env, deps, m, await resolveActionRef(env, deps, params.id), body.liked);
  }),
);

route(
  'POST',
  '/api/suggestions',
  true,
  memberWrite('suggestion', async ({ req, env, deps }, m) => sendSuggestion(env, deps, m, await readJson(req)), 201),
);

// Your own action: something kind you did that isn't on the site. Counts for you
// now (one a day) and goes to review as a suggestion; public once it's an action.
route('POST', '/api/own-actions', true, memberWrite('own', async ({ req, env, deps }, m) => logOwnAction(env, deps, m, await readJson(req)), 201));
// "Is it one of these?" while typing: close matches among the site's actions.
route('GET', '/api/actions/match', true, async ({ req, env }) => json(await matchActions(env, new URL(req.url).searchParams.get('q')), 200, { 'Cache-Control': 'public, max-age=60' }));

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
  const v = u.searchParams.get('videos');
  const videos = v === '1' ? true : v === '0' ? false : undefined;
  return json({ page, stories: await storiesFor(env, { limit: 20, offset: (page - 1) * 20, videos }) }, 200, { 'Cache-Control': 'public, max-age=60' });
});

// Video stories: uploaded in parts (a weak connection retries one part), checked, then served with ranges.
route('POST', '/api/stories/video/start', true, async ({ req, env, deps }) => json(await startVideo(env, deps, await requireMember(req, env, deps), await readJson(req)), 201));
route('PUT', '/api/stories/video/part', true, async ({ req, env, deps }) => {
  const u = new URL(req.url);
  return json(await uploadVideoPart(env, await requireMember(req, env, deps), u.searchParams.get('u') || '', Number(u.searchParams.get('n')), req));
});
route('POST', '/api/stories/video/complete', true, async ({ req, env, deps }) => json(await completeVideo(env, await requireMember(req, env, deps), await readJson(req))));
route('GET', '/media/videos/:key', false, async ({ req, env, params }) => serveVideo(env, `videos/${params.key}`, req));

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

route('GET', '/api/drops', true, async ({ req, env, deps }) => json(await shopDrops(env, deps, await optionalMember(req, env, deps)), 200, { 'Cache-Control': 'private, max-age=30' }));

// The shop: a product's live state (sizes, stock, can I buy now), checkout and "Notify me".
route('GET', '/api/shop/products/:handle', true, async ({ req, env, deps, params }) => {
  if (!/^[a-z0-9-]{1,120}$/.test(params.handle)) throw new HttpError(404, 'product_not_found', 'err-product-not-found');
  return json(await productState(env, deps, params.handle, await optionalMember(req, env, deps)), 200, { 'Cache-Control': 'private, max-age=15' });
});
route('POST', '/api/shop/checkout', true, async ({ req, env, deps }) =>
  json(await startCheckout(env, deps, await optionalMember(req, env, deps), await readJson(req), req.headers.get('CF-Connecting-IP'))));
route('POST', '/api/shop/notify', true, memberWrite('drop-notify', async ({ req, env, deps }, m) => setNotify(env, deps, m, await readJson(req))));

// Ripple: invites and "I'm in".
route('POST', '/api/invites', true, memberWrite('invite', async ({ req, env, deps, baseUrl }, m) => {
  const body = await readJson<{ actionId?: unknown; kind?: unknown; note?: unknown }>(req);
  if (typeof body.actionId === 'string') body.actionId = await resolveActionRef(env, deps, body.actionId);
  return createInvite(env, deps, m, body, baseUrl);
}, 201));

route('GET', '/api/invites/:code', true, async ({ req, env, deps, params }) =>
  json(await getInvite(env, deps, params.code, (await optionalMember(req, env, deps)) || (await guestFromRequest(req, env, deps, false)))),
);

// "I'm in" works without an account (a guest, with a first name).
route('POST', '/api/invites/:code/join', true, doerWrite('invite-join', true, async ({ req, env, deps, params }, m) => joinInvite(env, deps, m, params.code, await readJson(req).catch(() => ({})))));

route('DELETE', '/api/invites/:code/join', true, doerWrite('invite-leave', false, async ({ env, deps, params }, m) => leaveInvite(env, deps, m, params.code)));

route(
  'DELETE',
  '/api/stories/:id',
  true,
  memberWrite('story-delete', ({ env, deps, params }, m) => {
    const id = Number(params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(404, 'story_not_found', 'err-story-not-found');
    return deleteStory(env, deps, m, id);
  }),
);

route('GET', '/api/me', true, async ({ req, env, deps }) => json(await getAccount(env, deps, await requireMember(req, env, deps))));

// The member's home area only: a light call for the header on a device that has no location yet.
route('GET', '/api/me/home-area', true, async ({ req, env, deps }) => json({ homeArea: (await requireMember(req, env, deps)).home_area ?? null }));

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
  if (!intent) throw new HttpError(404, 'intent_expired', 'err-intent-expired');
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

// A failed write, from /lab: try it again or dismiss it.
route('POST', '/api/lab/failed', true, async ({ req, env, deps, ctx }) => {
  await assertLabAccess(env, await requireMember(req, env, deps));
  const out = await labFailedWrite(env, deps, await readJson(req));
  ctx.waitUntil(drain(env, deps, { limit: 5, deadlineMs: 10_000 }).catch(() => undefined));
  return json(out);
});

// Reviewing stories and suggestions from /lab.
route('GET', '/api/lab/review', true, async ({ req, env, deps }) => {
  await assertLabAccess(env, await requireMember(req, env, deps));
  return json(await reviewQueue(env, deps));
});
route('POST', '/api/lab/review', true, async ({ req, env, deps, ctx, baseUrl }) => {
  const me = await assertLabAccess(env, await requireMember(req, env, deps));
  const out = await labDecide(env, deps, me.email, await readJson(req), baseUrl);
  ctx.waitUntil(drain(env, deps, { limit: 5, deadlineMs: 10_000 }).catch(() => undefined));
  return json(out);
});

// The buyer, signed in on the foundation, keeps the pledges of their link.
route('POST', '/api/pledges/claim', true, async ({ req, env, deps }) => json(await claimPledges(env, deps, await requireMember(req, env, deps), await readJson(req))));

// Memberstack: member updates and deletions (signed by Svix).
route('POST', '/api/memberstack/webhook', false, async ({ req, env, deps }) => memberstackWebhook(env, deps, req));

// --- Email links ------------------------------------------------------------

async function unsubscribe({ req, env, deps }: Call): Promise<Response> {
  const token = new URL(req.url).searchParams.get('t') || '';
  const parsed = await verifyUnsubscribe(env, token);
  if (!parsed) return new Response(word('unsub-invalid'), { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  await env.DB.prepare(`UPDATE members SET ${EMAIL_KINDS[parsed.kind]} = 0, updated_at = ?2 WHERE id = ?1`).bind(parsed.memberId, iso(deps.now())).run();
  return new Response(word('unsub-done'), {
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
    // Keeps Shopify's order, product and customer-deletion webhooks pointed here.
    ['shopify-webhooks', 'shopifyWebhooks', 24 * HOUR, () => ensureShopifyWebhooks(env, deps, `${baseUrl}/api/webhooks/shopify`)],
    ['backup', 'backup', 24 * HOUR, () => backupDatabase(env, deps)],
    // Phase 2: review in the CMS (the Webflow webhook is the fast path).
    ['review', 'review', 15 * 60 * 1000, () => reviewAll(env, deps, baseUrl)],
    // Phase 3: drops, counts and pledges.
    ['drop-releases', 'dropReleases', HOUR, () => scheduleDropReleases(env, deps)],
    ['write-counts', 'writeCounts', HOUR, () => writeCountsToCms(env, deps)],
    ['sync-orders', 'syncOrders', 6 * HOUR, () => syncRecentOrders(env, deps, { days: 3 })],
    ['pledge-reminders', 'pledgeReminders', HOUR, () => pledgeReminders(env, deps, baseUrl)],
    // Buyers from our shop get their "Keep your pledge" link.
    ['claim-emails', 'claimEmails', 0, () => claimEmails(env, deps, baseUrl)],
    // The shop: Shopify → Webflow (webhooks do it at once; this is the safety net), and "Notify me" emails.
    ['sync-shop', 'syncShop', HOUR, () => syncShop(env, deps)],
    ['drop-notify', 'dropNotify', 0, () => dropNotifications(env, deps, baseUrl)],
    // Phase 4: one summary email a day per inviter.
    ['invite-summaries', 'inviteSummaries', 24 * HOUR, () => inviteSummaries(env, deps, baseUrl)],
    // Try before sign-up: guests not seen for 30 days can no longer be claimed.
    ['expire-guests', 'expireGuests', 24 * HOUR, () => expireGuests(env, deps)],
    // Active membership: people drop out (and in) on time even without a new action.
    ['active-members', 'activeMembers', 6 * HOUR, () => refreshAllActive(env, deps)],
  ];
  for (const [job, key, every, run] of jobs) {
    const last = await env.DB.prepare(`SELECT last_run_at FROM job_runs WHERE job = ?1`).bind(job).first<{ last_run_at: string }>();
    if (last && deps.now().getTime() - Date.parse(last.last_run_at) <= every) continue;
    try {
      const result = await run();
      out[key] = result;
      // The Lab shows each job's last answer (counts and any errors), kept a week.
      await env.CACHE.put(`job-result:${job}`, JSON.stringify({ at: iso(deps.now()), result }).slice(0, 2000), { expirationTtl: 7 * 86_400 });
      const errs = (result as { errors?: unknown[] }).errors;
      if (errs?.length) await reportError(env, deps, { where: `job ${job}`, error: new Error(`${errs.length} item(s) failed`), details: { errors: errs } });
      await env.DB.prepare(`INSERT INTO job_runs (job, last_run_at) VALUES (?1, ?2) ON CONFLICT (job) DO UPDATE SET last_run_at = excluded.last_run_at`)
        .bind(job, iso(deps.now()))
        .run();
    } catch (e) {
      out[key] = { error: (e as Error).message };
      await env.CACHE.put(`job-result:${job}`, JSON.stringify({ at: iso(deps.now()), error: (e as Error).message }).slice(0, 2000), { expirationTtl: 7 * 86_400 });
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
    if (/^(products|collections)\/(create|update|delete)$/.test(topic)) {
      // A product or drop changed: work drops out again, and copy the shop to Webflow shortly.
      await forgetDrops(env);
      await queueShopSync(env, deps).run();
      return json({ ok: true, refreshed: 'shop' });
    }
    if (topic === 'orders/create' || topic === 'orders/updated' || topic === 'orders/cancelled' || topic === 'orders/paid') {
      const order = orderFromWebhook(body);
      // Stock moved: the site's "sold out" (home hero, menu) follows shortly.
      if (topic === 'orders/create' || topic === 'orders/cancelled') await queueShopSync(env, deps).run();
      return json({ ok: true, ...(order ? await ingestOrder(env, deps, order) : { ignored: 'no order' }) });
    }
    if (topic === 'refunds/create') {
      await queueShopSync(env, deps).run();
      return json({ ok: true, ...(await refundOrder(env, deps, body.order_id)) });
    }
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
    'Access-Control-Allow-Headers': 'Authorization, Content-Type, Idempotency-Key, CF-Turnstile-Response, X-HF-Guest, X-HF-Ref',
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
  const appDeps: Deps = { ...defaultDeps(), ...opts.deps };

  async function handle(req: Request, env: Env, ctx: Ctx): Promise<Response> {
    const url = new URL(req.url);
    let path = url.pathname;
    if (base && path.startsWith(base)) path = path.slice(base.length) || '/';
    const baseUrl = `${url.origin}${base}`;
    const deps = appDeps;

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
      if (e instanceof HttpError) return withHeaders(errorResponse(e, WORDING), found.r.site ? cors : {});
      if (e instanceof UpstreamError) {
        ctx.waitUntil(reportError(env, deps, { where: `${req.method} ${path}`, error: e, details: { service: e.service, status: e.status } }));
        return withHeaders(
          json({ error: 'service_unavailable', message: word('error-unavailable') }, 503, { 'Retry-After': '5' }),
          found.r.site ? cors : {},
        );
      }
      ctx.waitUntil(reportError(env, deps, { where: `${req.method} ${path}`, error: e, details: { url: `${url.origin}${url.pathname}` } }));
      return withHeaders(json({ error: 'server_error', message: word('error-something') }, 500), found.r.site ? cors : {});
    }
  }

  return { handle, deps: appDeps };
}
