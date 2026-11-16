import { CMS, COUNT_THRESHOLD } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import type { Member } from '../identity';
import { consumeDaily, refundDaily } from '../safety';
import { enqueue } from '../queue';
import * as webflow from '../webflow';
import { recomputeKeeps } from './pledges';
import { storiesFor } from './stories';
import { doneWithNames, displayName, rippleTotal } from './ripple';

export interface ActionRow {
  cms_item_id: string;
  slug: string;
  title: string;
  short_answer: string | null;
  can_do_with_others: number;
  status: string;
  suggestion_cms_id: string | null;
}

const ID_PATTERN = /^[a-f0-9]{24}$/;

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,199}$/;

export function assertActionId(id: string): void {
  if (!ID_PATTERN.test(id)) throw new HttpError(400, 'invalid_action', 'That action could not be found.');
}

/**
 * Pages know their address (slug), not the CMS item ID. A call may name the
 * action either way; records are always stored by CMS item ID.
 */
export async function resolveActionRef(env: Env, deps: Deps, ref: string): Promise<string> {
  if (ID_PATTERN.test(ref)) return ref;
  if (!SLUG_PATTERN.test(ref)) throw new HttpError(400, 'invalid_action', 'That action could not be found.');
  const find = () =>
    env.DB.prepare(`SELECT cms_item_id FROM actions WHERE slug = ?1 ORDER BY status = 'published' DESC LIMIT 1`).bind(ref).first<{ cms_item_id: string }>();
  let row = await find();
  if (!row) {
    // A new or renamed action: refresh the mirror once.
    await syncActions(env, deps);
    row = await find();
  }
  if (!row) throw new HttpError(404, 'action_not_found', 'This action is no longer available.');
  return row.cms_item_id;
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
    suggestion_cms_id: typeof f.suggestion === 'string' && f.suggestion ? (f.suggestion as string) : null,
    synced_at: now,
  };
}

export function upsertStatement(env: Env, r: ReturnType<typeof rowFromItem>): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO actions (cms_item_id, slug, title, short_answer, can_do_with_others, status, synced_at, suggestion_cms_id)
     VALUES (?1, ?2, ?3, ?4, ?5, 'published', ?6, ?7)
     ON CONFLICT (cms_item_id) DO UPDATE SET slug = excluded.slug, title = excluded.title, short_answer = excluded.short_answer,
       can_do_with_others = excluded.can_do_with_others, status = 'published', synced_at = excluded.synced_at,
       suggestion_cms_id = excluded.suggestion_cms_id`,
  ).bind(r.cms_item_id, r.slug, r.title, r.short_answer, r.can_do_with_others, r.synced_at, r.suggestion_cms_id);
}

export { rowFromItem };

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
  await env.CACHE.delete('most-done');
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
  const suggester = action.suggestion_cms_id
    ? await env.DB.prepare(
        `SELECT m.first_name, m.share_name FROM suggestions s JOIN members m ON m.id = s.member_id
         WHERE s.cms_item_id = ?1 AND m.deleted_at IS NULL`,
      )
        .bind(action.suggestion_cms_id)
        .first<{ first_name: string | null; share_name: string | null }>()
    : null;
  const state: Record<string, unknown> = {
    actionId,
    slug: action.slug,
    title: action.title,
    live: action.status === 'published',
    count: await publicCount(env, actionId),
    canDoWithOthers: action.can_do_with_others === 1,
    suggestedBy: suggester ? suggester.share_name || suggester.first_name || null : null,
    stories: await storiesFor(env, { actionId, limit: 20 }),
  };
  if (member) {
    const last = await env.DB.prepare(`SELECT MAX(done_at) AS last, COUNT(*) AS n FROM done_marks WHERE member_id = ?1 AND action_id = ?2`)
      .bind(member.id, actionId)
      .first<{ last: string | null; n: number }>();
    const like = await env.DB.prepare(`SELECT value FROM likes WHERE member_id = ?1 AND action_id = ?2`).bind(member.id, actionId).first<{ value: number }>();
    const story = await env.DB.prepare(`SELECT id, status FROM stories WHERE member_id = ?1 AND action_id = ?2`)
      .bind(member.id, actionId)
      .first<{ id: number; status: string }>();
    const today = iso(deps.now()).slice(0, 10);
    state.me = {
      done: !!last?.last,
      lastDoneAt: last?.last ?? null,
      timesDone: last?.n ?? 0,
      doneToday: !!last?.last && last.last.slice(0, 10) === today,
      canUndo: !!last?.last && !story,
      liked: like?.value === 1,
      tally: await memberTally(env, member.id),
      story: story || null,
      doneWith: last?.last ? await doneWithNames(env, member.id, actionId) : [],
      name: displayName(member),
    };
  }
  return state;
}

/**
 * Records "I did this". Doing it again is allowed at most once a day per
 * action; the public count counts people, the member's tally every time.
 */
export async function markDone(env: Env, deps: Deps, member: Member, actionId: string) {
  const action = await getAction(env, deps, actionId);
  if (!action || action.status !== 'published') throw new HttpError(404, 'action_not_found', 'This action is no longer available.');
  const now = iso(deps.now());
  const today = await env.DB.prepare(`SELECT 1 AS x FROM done_marks WHERE member_id = ?1 AND action_id = ?2 AND substr(done_at, 1, 10) = ?3 LIMIT 1`)
    .bind(member.id, actionId, now.slice(0, 10))
    .first();
  if (today) throw new HttpError(409, 'done_today', 'You have already marked this today. You can do it again tomorrow.');
  await consumeDaily(env, deps, member.id, 'done');
  try {
    const mark = await env.DB.prepare(
      `INSERT INTO done_marks (member_id, action_id, done_at, action_title, source) VALUES (?1, ?2, ?3, ?4, 'site') RETURNING id, done_at`,
    )
      .bind(member.id, actionId, now, action.title)
      .first<{ id: number; done_at: string }>();
    await forgetCounts(env, actionId);
    await recomputeKeeps(env, member.id);
    return {
      markId: mark!.id,
      doneAt: mark!.done_at,
      tally: await memberTally(env, member.id),
      count: await publicCount(env, actionId),
      ripple: await rippleTotal(env, member.id),
    };
  } catch (e) {
    await refundDaily(env, deps, member.id, 'done');
    throw e;
  }
}

/** Removes the member's latest mark for an action, unless a story is attached. */
export async function undoDone(env: Env, deps: Deps, member: Member, actionId: string) {
  assertActionId(actionId);
  const story = await env.DB.prepare(`SELECT 1 AS x FROM stories WHERE member_id = ?1 AND action_id = ?2`).bind(member.id, actionId).first();
  if (story) throw new HttpError(409, 'story_attached', 'Your story is attached to this action. Delete the story first, then undo.');
  const mark = await env.DB.prepare(`SELECT id FROM done_marks WHERE member_id = ?1 AND action_id = ?2 ORDER BY done_at DESC, id DESC LIMIT 1`)
    .bind(member.id, actionId)
    .first<{ id: number }>();
  if (!mark) throw new HttpError(404, 'not_done', 'This action is not marked as done.');
  await env.DB.batch([
    env.DB.prepare(`UPDATE pledges SET status = 'open', kept_by_done_mark_id = NULL WHERE kept_by_done_mark_id = ?1`).bind(mark.id),
    env.DB.prepare(`DELETE FROM done_marks WHERE id = ?1`).bind(mark.id),
  ]);
  await forgetCounts(env, actionId);
  await recomputeKeeps(env, member.id);
  const left = await env.DB.prepare(`SELECT COUNT(*) AS n FROM done_marks WHERE member_id = ?1 AND action_id = ?2`).bind(member.id, actionId).first<{ n: number }>();
  return { actionId, done: (left?.n ?? 0) > 0, tally: await memberTally(env, member.id), count: await publicCount(env, actionId) };
}

async function forgetCounts(env: Env, actionId: string): Promise<void> {
  await env.CACHE.delete(`count:${actionId}`);
  await env.CACHE.delete('most-done');
}

/** "Most done": actions done by at least 10 people, hidden until 5 qualify. */
export async function mostDone(env: Env) {
  const cached = await env.CACHE.get('most-done', 'json');
  if (cached) return cached;
  const rows = await env.DB.prepare(
    `SELECT a.cms_item_id AS actionId, a.slug, a.title, COUNT(DISTINCT d.member_id) AS people
     FROM done_marks d JOIN actions a ON a.cms_item_id = d.action_id
     WHERE a.status = 'published'
     GROUP BY a.cms_item_id HAVING people >= ?1 ORDER BY people DESC, a.title LIMIT 50`,
  )
    .bind(COUNT_THRESHOLD)
    .all<{ actionId: string; slug: string; title: string; people: number }>();
  const out = { actions: rows.results.length >= MOST_DONE_MIN ? rows.results : [] };
  await env.CACHE.put('most-done', JSON.stringify(out), { expirationTtl: 300 });
  return out;
}
const MOST_DONE_MIN = 5;

/**
 * Daily: writes each action's public count (people, 0 below the threshold)
 * and its likes (minus imported "don't like") to the CMS, so the numbers are
 * in the page for search engines and for Mickey. Only changes are written.
 */
export async function writeCountsToCms(env: Env, deps: Deps) {
  const rows = await env.DB.prepare(
    `SELECT a.cms_item_id AS id,
       (SELECT COUNT(DISTINCT member_id) FROM done_marks d WHERE d.action_id = a.cms_item_id) AS people,
       (SELECT COALESCE(SUM(value), 0) FROM likes l WHERE l.action_id = a.cms_item_id) AS votes,
       c.done_count AS lastDone, c.votes AS lastVotes
     FROM actions a LEFT JOIN cms_counts c ON c.action_id = a.cms_item_id
     WHERE a.status = 'published'`,
  ).all<{ id: string; people: number; votes: number; lastDone: number | null; lastVotes: number | null }>();
  const now = iso(deps.now());
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows.results) {
    const done = r.people >= COUNT_THRESHOLD ? r.people : 0;
    if (done === (r.lastDone ?? 0) && r.votes === (r.lastVotes ?? 0) && r.lastDone !== null) continue;
    stmts.push(
      enqueue(env, deps, `counts:${r.id}:${now}`, { op: 'webflow.updateLive', collectionId: CMS.actions.id, itemId: r.id, fieldData: { 'done-count': done, votes: r.votes } }),
      env.DB.prepare(
        `INSERT INTO cms_counts (action_id, done_count, votes, written_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (action_id) DO UPDATE SET done_count = excluded.done_count, votes = excluded.votes, written_at = excluded.written_at`,
      ).bind(r.id, done, r.votes, now),
    );
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { changed: stmts.length / 2 };
}

/** Sets or clears the member's like. Likes are private; they are never shown to visitors. */
export async function setLike(env: Env, deps: Deps, member: Member, actionId: string, liked: boolean) {
  const action = await getAction(env, deps, actionId);
  if (!action || action.status !== 'published') throw new HttpError(404, 'action_not_found', 'This action is no longer available.');
  if (liked) {
    await env.DB.prepare(
      `INSERT INTO likes (member_id, action_id, value, updated_at, source) VALUES (?1, ?2, 1, ?3, 'site')
       ON CONFLICT (member_id, action_id) DO UPDATE SET value = 1, updated_at = excluded.updated_at, source = 'site'`,
    )
      .bind(member.id, actionId, iso(deps.now()))
      .run();
  } else {
    // Only a like is cleared; an imported "don't like" stays as a private signal.
    await env.DB.prepare(`DELETE FROM likes WHERE member_id = ?1 AND action_id = ?2 AND value = 1`).bind(member.id, actionId).run();
  }
  return { actionId, liked };
}
