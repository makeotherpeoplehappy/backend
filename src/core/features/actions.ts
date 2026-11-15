import { CMS, COUNT_THRESHOLD } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import type { Member } from '../identity';
import { consumeDaily, refundDaily } from '../safety';
import * as webflow from '../webflow';

export interface ActionRow {
  cms_item_id: string;
  slug: string;
  title: string;
  short_answer: string | null;
  can_do_with_others: number;
  status: string;
}

const ID_PATTERN = /^[a-f0-9]{24}$/;

export function assertActionId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'invalid_action', 'That action could not be found.');
}

function rowFromItem(item: webflow.WebflowItem, now: string) {
  const f = item.fieldData || {};
  const withIds = Array.isArray(f['do-it-with']) ? (f['do-it-with'] as string[]) : [];
  return {
    cms_item_id: item.id,
    slug: String(f.slug || ''),
    title: String(f.name || ''),
    short_answer: typeof f['short-answer'] === 'string' ? (f['short-answer'] as string) : null,
    can_do_with_others: withIds.some((id) => id !== CMS.actions.onMyOwnCompanionId) ? 1 : 0,
    synced_at: now,
  };
}

function upsertStatement(env: Env, r: ReturnType<typeof rowFromItem>): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO actions (cms_item_id, slug, title, short_answer, can_do_with_others, status, synced_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'published', ?6)
     ON CONFLICT (cms_item_id) DO UPDATE SET slug = excluded.slug, title = excluded.title, short_answer = excluded.short_answer,
       can_do_with_others = excluded.can_do_with_others, status = 'published', synced_at = excluded.synced_at`,
  ).bind(r.cms_item_id, r.slug, r.title, r.short_answer, r.can_do_with_others, r.synced_at);
}

/** Copies every published action from Webflow; actions no longer live are marked removed. */
export async function syncActions(env: Env, deps: Deps): Promise<{ published: number; removed: number }> {
  const items = await webflow.listLiveItems(env, deps, CMS.actions.id);
  const now = iso(deps.now());
  const rows = items.filter((i) => !i.isArchived).map((i) => rowFromItem(i, now));
  const stmts = rows.map((r) => upsertStatement(env, r));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  const removed = await env.DB.prepare(`UPDATE actions SET status = 'removed', synced_at = ?1 WHERE status = 'published' AND synced_at < ?1`)
    .bind(now)
    .run();
  await env.CACHE.delete('actions:can-do-with');
  return { published: rows.length, removed: removed.meta.changes };
}

/** The action from the mirror, fetched from Webflow when it is new. */
export async function getAction(env: Env, deps: Deps, id: string): Promise<ActionRow | null> {
  assertActionId(id);
  const row = await env.DB.prepare(`SELECT * FROM actions WHERE cms_item_id = ?1`).bind(id).first<ActionRow>();
  if (row) return row;
  const item = await webflow.getLiveItem(env, deps, CMS.actions.id, id);
  if (!item) return null;
  const r = rowFromItem(item, iso(deps.now()));
  await upsertStatement(env, r).run();
  return { ...r, status: 'published' };
}

export async function publicCount(env: Env, actionId: string): Promise<number | null> {
  const key = `count:${actionId}`;
  const cached = await env.CACHE.get(key);
  let n: number;
  if (cached !== null) {
    n = Number(cached);
  } else {
    const r = await env.DB.prepare(`SELECT COUNT(DISTINCT member_id) AS n FROM done_marks WHERE action_id = ?1`).bind(actionId).first<{ n: number }>();
    n = r?.n ?? 0;
    await env.CACHE.put(key, String(n), { expirationTtl: 300 });
  }
  return n >= COUNT_THRESHOLD ? n : null;
}

export async function memberTally(env: Env, memberId: number): Promise<number> {
  const r = await env.DB.prepare(`SELECT COUNT(*) AS n FROM done_marks WHERE member_id = ?1`).bind(memberId).first<{ n: number }>();
  return r?.n ?? 0;
}

/** Everything the action page needs in one call. */
export async function actionState(env: Env, deps: Deps, actionId: string, member: Member | null) {
  const action = await getAction(env, deps, actionId);
  if (!action) throw new HttpError(404, 'action_not_found', 'This action is no longer available.');
  const stories = await env.DB.prepare(
    `SELECT s.id, s.text, s.photo_description, s.video_url, s.created_at, CASE WHEN s.show_name = 1 THEN m.first_name END AS first_name
     FROM stories s JOIN members m ON m.id = s.member_id
     WHERE s.action_id = ?1 AND s.status = 'approved' ORDER BY s.created_at DESC LIMIT 20`,
  )
    .bind(actionId)
    .all();
  const state: Record<string, unknown> = {
    actionId,
    live: action.status === 'published',
    count: await publicCount(env, actionId),
    canDoWithOthers: action.can_do_with_others === 1,
    stories: stories.results,
  };
  if (member) {
    const last = await env.DB.prepare(`SELECT MAX(done_at) AS last FROM done_marks WHERE member_id = ?1 AND action_id = ?2`)
      .bind(member.id, actionId)
      .first<{ last: string | null }>();
    const like = await env.DB.prepare(`SELECT value FROM likes WHERE member_id = ?1 AND action_id = ?2`).bind(member.id, actionId).first<{ value: number }>();
    state.me = { done: !!last?.last, lastDoneAt: last?.last ?? null, liked: like?.value === 1 };
  }
  return state;
}

/**
 * Records "I did this". Minimal for Phase 1 (the daily cap and one record per
 * click); Phase 3 adds "again once a day" and undo.
 */
export async function markDone(env: Env, deps: Deps, member: Member, actionId: string) {
  const action = await getAction(env, deps, actionId);
  if (!action || action.status !== 'published') throw new HttpError(404, 'action_not_found', 'This action is no longer available.');
  await consumeDaily(env, deps, member.id, 'done');
  try {
    const mark = await env.DB.prepare(
      `INSERT INTO done_marks (member_id, action_id, done_at, action_title, source) VALUES (?1, ?2, ?3, ?4, 'site') RETURNING id, done_at`,
    )
      .bind(member.id, actionId, iso(deps.now()), action.title)
      .first<{ id: number; done_at: string }>();
    await env.CACHE.delete(`count:${actionId}`);
    return { markId: mark!.id, doneAt: mark!.done_at, tally: await memberTally(env, member.id), count: await publicCount(env, actionId) };
  } catch (e) {
    await refundDaily(env, deps, member.id, 'done');
    throw e;
  }
}
