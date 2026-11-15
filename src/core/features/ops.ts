// Operations: Webflow webhooks, the daily backup, and the /lab KPIs.

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso, utcDay } from '../http';
import type { Member } from '../identity';
import * as webflow from '../webflow';
import { forgetDrops } from './drops';

// ---------------------------------------------------------------------------
// Webflow webhooks. The message is only a hint that something changed: the
// item is always read back from the Webflow API, so a forged message can at
// most cause an extra read. A per-minute cap keeps that cheap.
// ---------------------------------------------------------------------------

const WEBHOOK_LIMIT_PER_MINUTE = 120;

export async function handleWebflowWebhook(env: Env, deps: Deps, body: Record<string, unknown>) {
  const minute = `wfhook:${iso(deps.now()).slice(0, 16)}`;
  const seen = Number((await env.CACHE.get(minute)) || '0');
  if (seen >= WEBHOOK_LIMIT_PER_MINUTE) return { ok: true, ignored: 'rate limit' };
  await env.CACHE.put(minute, String(seen + 1), { expirationTtl: 120 });

  const trigger = String(body.triggerType || '');
  const payload = (body.payload || {}) as Record<string, unknown>;
  const collectionId = String(payload.collectionId || '');
  const itemId = String(payload.id || payload.itemId || '');

  if (trigger === 'site_publish') {
    // Everything may have changed: run the hourly mirror at the next tick.
    await env.DB.prepare(`DELETE FROM job_runs WHERE job IN ('sync-actions')`).run();
    await forgetDrops(env);
    return { ok: true, resync: 'actions' };
  }
  if (collectionId === CMS.drops.id) {
    await forgetDrops(env);
    return { ok: true, refreshed: 'drops' };
  }
  if (collectionId === CMS.actions.id && /^[a-f0-9]{24}$/.test(itemId)) {
    const item = await webflow.getLiveItem(env, deps, CMS.actions.id, itemId);
    const now = iso(deps.now());
    if (!item) {
      await env.DB.prepare(`UPDATE actions SET status = 'removed', synced_at = ?2 WHERE cms_item_id = ?1`).bind(itemId, now).run();
      await env.CACHE.delete(`count:${itemId}`);
      return { ok: true, action: itemId, live: false };
    }
    const f = item.fieldData || {};
    const withIds = Array.isArray(f['do-it-with']) ? (f['do-it-with'] as string[]) : [];
    await env.DB.prepare(
      `INSERT INTO actions (cms_item_id, slug, title, short_answer, can_do_with_others, status, synced_at)
       VALUES (?1, ?2, ?3, ?4, ?5, 'published', ?6)
       ON CONFLICT (cms_item_id) DO UPDATE SET slug = excluded.slug, title = excluded.title, short_answer = excluded.short_answer,
         can_do_with_others = excluded.can_do_with_others, status = 'published', synced_at = excluded.synced_at`,
    )
      .bind(
        item.id,
        String(f.slug || ''),
        String(f.name || ''),
        typeof f['short-answer'] === 'string' ? f['short-answer'] : null,
        withIds.some((id) => id !== CMS.actions.onMyOwnCompanionId) ? 1 : 0,
        now,
      )
      .run();
    return { ok: true, action: itemId, live: true };
  }
  return { ok: true, ignored: trigger || 'unknown' };
}

// ---------------------------------------------------------------------------
// Daily backup of every table to object storage, kept for 30 days.
// ---------------------------------------------------------------------------

const BACKUP_PREFIX = 'backups/';
const KEEP_DAYS = 30;

export async function backupDatabase(env: Env, deps: Deps) {
  const tables = await env.DB.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' AND name NOT LIKE 'd1_%' ORDER BY name`,
  ).all<{ name: string }>();
  const dump: Record<string, unknown[]> = {};
  let rows = 0;
  for (const { name } of tables.results) {
    if (!/^[a-z_][a-z0-9_]*$/.test(name)) continue;
    const all: unknown[] = [];
    for (let offset = 0; ; offset += 1000) {
      const page = await env.DB.prepare(`SELECT * FROM "${name}" LIMIT 1000 OFFSET ?1`).bind(offset).all();
      all.push(...page.results);
      if (page.results.length < 1000) break;
    }
    dump[name] = all;
    rows += all.length;
  }
  const day = utcDay(deps.now());
  const key = `${BACKUP_PREFIX}${day}.json`;
  const text = JSON.stringify({ createdAt: iso(deps.now()), environment: env.ENVIRONMENT || null, tables: dump });
  await env.MEDIA.put(key, text, { httpMetadata: { contentType: 'application/json' } });

  const cutoff = utcDay(new Date(deps.now().getTime() - KEEP_DAYS * 86_400_000));
  let removed = 0;
  const listed = await env.MEDIA.list({ prefix: BACKUP_PREFIX, limit: 1000 });
  for (const obj of listed.objects) {
    const d = obj.key.slice(BACKUP_PREFIX.length, BACKUP_PREFIX.length + 10);
    if (d < cutoff) {
      await env.MEDIA.delete(obj.key);
      removed++;
    }
  }
  return { key, tables: Object.keys(dump).length, rows, bytes: text.length, removedOld: removed };
}

// ---------------------------------------------------------------------------
// KPIs for /lab. Only accounts on the LAB_EMAILS allow-list may read them.
// ---------------------------------------------------------------------------

export function assertLabAccess(env: Env, member: Member) {
  const allowed = (env.LAB_EMAILS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  if (!allowed.length) throw new HttpError(403, 'lab_not_set_up', 'The dashboard is not set up yet: add LAB_EMAILS in the backend settings.');
  if (!member.email || !allowed.includes(member.email.toLowerCase())) throw new HttpError(403, 'lab_forbidden', 'This account cannot open the dashboard.');
}

export async function labKpis(env: Env, deps: Deps) {
  const now = deps.now();
  const daysAgo = (n: number) => iso(new Date(now.getTime() - n * 86_400_000));
  const one = async <T>(sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).first<T>()) as T;
  const many = async <T>(sql: string, ...args: unknown[]) => (await env.DB.prepare(sql).bind(...args).all<T>()).results;
  const n = async (sql: string, ...args: unknown[]) => (await one<{ n: number }>(sql, ...args))?.n ?? 0;

  const d7 = daysAgo(7);
  const d30 = daysAgo(30);
  const live = `deleted_at IS NULL`;

  const impact = {
    peopleMadeHappy: await n(`SELECT COUNT(*) AS n FROM done_marks`),
    peopleMadeHappy30d: await n(`SELECT COUNT(*) AS n FROM done_marks WHERE done_at >= ?1`, d30),
    peopleMadeHappy7d: await n(`SELECT COUNT(*) AS n FROM done_marks WHERE done_at >= ?1`, d7),
    actionsEverDone: await n(`SELECT COUNT(DISTINCT action_id) AS n FROM done_marks`),
    pledgesMade: await n(`SELECT COUNT(*) AS n FROM pledges WHERE status != 'cancelled'`),
    pledgesKept: await n(`SELECT COUNT(*) AS n FROM pledges WHERE status = 'kept'`),
  };
  const engagement = {
    members: await n(`SELECT COUNT(*) AS n FROM members WHERE ${live}`),
    newMembers30d: await n(`SELECT COUNT(*) AS n FROM members WHERE ${live} AND created_at >= ?1`, d30),
    activeMembers7d: await n(`SELECT COUNT(DISTINCT member_id) AS n FROM done_marks WHERE done_at >= ?1`, d7),
    activeMembers30d: await n(`SELECT COUNT(DISTINCT member_id) AS n FROM done_marks WHERE done_at >= ?1`, d30),
    likes: await n(`SELECT COUNT(*) AS n FROM likes WHERE value = 1`),
    suggestions: await n(`SELECT COUNT(*) AS n FROM suggestions`),
    suggestionsWaiting: await n(`SELECT COUNT(*) AS n FROM suggestions WHERE status = 'new'`),
    stories: await n(`SELECT COUNT(*) AS n FROM stories`),
    storiesWaiting: await n(`SELECT COUNT(*) AS n FROM stories WHERE status = 'new'`),
    dropSignups: await n(`SELECT COUNT(*) AS n FROM drop_signups`),
  };
  const daily = await many<{ day: string; done: number }>(
    `SELECT substr(done_at, 1, 10) AS day, COUNT(*) AS done FROM done_marks WHERE done_at >= ?1 GROUP BY day ORDER BY day`,
    d30,
  );
  const topActions = await many<{ title: string; slug: string | null; people: number; times: number }>(
    `SELECT COALESCE(a.title, d.action_title) AS title, a.slug AS slug, COUNT(DISTINCT d.member_id) AS people, COUNT(*) AS times
     FROM done_marks d LEFT JOIN actions a ON a.cms_item_id = d.action_id
     WHERE d.done_at >= ?1 GROUP BY d.action_id ORDER BY people DESC, times DESC LIMIT 10`,
    d30,
  );
  const mostLiked = await many<{ title: string; likes: number }>(
    `SELECT COALESCE(a.title, l.action_id) AS title, COUNT(*) AS likes FROM likes l LEFT JOIN actions a ON a.cms_item_id = l.action_id
     WHERE l.value = 1 GROUP BY l.action_id ORDER BY likes DESC LIMIT 5`,
  );
  const drops = await many<{ drop: string; signups: number }>(`SELECT drop_slug AS "drop", COUNT(*) AS signups FROM drop_signups GROUP BY drop_slug ORDER BY signups DESC`);
  const health = {
    queuePending: await n(`SELECT COUNT(*) AS n FROM outbox WHERE status IN ('pending', 'running')`),
    queueFailed: await n(`SELECT COUNT(*) AS n FROM outbox WHERE status = 'dead'`),
    actionsMirrored: await n(`SELECT COUNT(*) AS n FROM actions WHERE status = 'published'`),
    productsSynced: await n(`SELECT COUNT(*) AS n FROM product_sync WHERE state = 'live'`),
    jobs: await many<{ job: string; last_run_at: string }>(`SELECT job, last_run_at FROM job_runs ORDER BY job`),
  };
  return { generatedAt: iso(now), environment: env.ENVIRONMENT || null, impact, engagement, daily, topActions, mostLiked, drops, health };
}
