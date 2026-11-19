// Your own action: something kind a member did that isn't on the site.
//
// It counts for them straight away – their tally, their weeks and their
// ripple – at most one a day, and it goes to the review queue as a suggestion
// (kind 'own'). Public numbers, the live feed and the per-action counts leave
// it out until the suggestion is approved and the action made from it is
// published; the mark then moves to that action (relinkOwnMarks).

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import type { Member } from '../identity';
import { refreshActive } from './active';
import { memberTally, PEOPLE_ANSWERS, refCodeFor } from './actions';
import { recomputeKeeps } from './pledges';
import { forgetRings, rippleView } from './rings';
import { cleanText, createSuggestion, similarity, titleFrom } from './submissions';
import { storyRemovalStatements, storySlug } from './stories';
import { enqueue } from '../queue';

export const OWN_PREFIX = 'own-';
const MAX_OWN = 140;
/** Own actions that can be logged in one day (UTC). */
export const OWN_PER_DAY = 10;
const WHO = new Set(Object.values(CMS.actions.whoSlugs));

export async function logOwnAction(env: Env, deps: Deps, member: Member, body: { text?: unknown; who?: unknown; people?: unknown }) {
  const text = cleanText(body.text, MAX_OWN);
  if (text.length < 3) throw new HttpError(400, 'empty_own', 'err-own-empty');
  const who = typeof body.who === 'string' && body.who ? body.who : null;
  if (who && !WHO.has(who)) throw new HttpError(400, 'invalid_who', 'err-own-who');
  const people = body.people === undefined || body.people === null || body.people === '' ? 1 : typeof body.people === 'string' ? PEOPLE_ANSWERS[body.people] : undefined;
  if (!people) throw new HttpError(400, 'invalid_people', 'err-invalid-people');

  // Up to ten of your own a day. The site's actions have no limit.
  const now = iso(deps.now());
  const today = await env.DB.prepare(`SELECT COUNT(*) AS n FROM done_marks WHERE member_id = ?1 AND suggestion_id IS NOT NULL AND substr(done_at, 1, 10) = ?2`)
    .bind(member.id, now.slice(0, 10))
    .first<{ n: number }>();
  if ((today?.n ?? 0) >= OWN_PER_DAY) throw new HttpError(429, 'own_daily', 'err-own-daily');

  const id = await createSuggestion(env, deps, member, {
    text,
    kind: 'own',
    who: who ? JSON.stringify([who]) : null,
    limited: false,
    note: `Done by the member${who ? ` for ${who.replace(/-/g, ' ')}` : ''}: counts for them privately until approved and published.`,
  });
  await env.DB.prepare(
    `INSERT INTO done_marks (member_id, action_id, done_at, action_title, source, people, suggestion_id) VALUES (?1, ?2, ?3, ?4, 'own', ?5, ?6)`,
  )
    .bind(member.id, `${OWN_PREFIX}${id}`, now, titleFrom(text), people, id)
    .run();
  await forgetRings(env, member.id);
  await recomputeKeeps(env, member.id);
  const active = await refreshActive(env, deps, member.id);
  return { id, active, tally: await memberTally(env, member.id), rippleView: await rippleView(env, member.id, true), refCode: await refCodeFor(env, member) };
}

/** "Is it one of these?": published actions close to what the member is typing. */
export async function matchActions(env: Env, q: unknown) {
  const text = cleanText(q, MAX_OWN);
  if (text.length < 4) return { matches: [] };
  const rows = await env.DB.prepare(`SELECT slug, title FROM actions WHERE status = 'published' AND hidden = 0`).all<{ slug: string; title: string }>();
  const matches = rows.results
    .map((r) => ({ ...r, score: similarity(text, r.title) }))
    .filter((r) => r.score >= 0.5)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ slug, title }) => ({ slug, title }));
  return { matches };
}

/**
 * Once an action made from an own-action suggestion is published, its marks move to
 * it and count in public, and a story told about it moves with them.
 */
export async function relinkOwn(env: Env, deps: Deps, suggestionId: number, actionId: string, title: string): Promise<D1PreparedStatement[]> {
  const ref = `${OWN_PREFIX}${suggestionId}`;
  const stories = await env.DB.prepare(`SELECT id, cms_item_id FROM stories WHERE action_id = ?1`).bind(ref).all<{ id: number; cms_item_id: string | null }>();
  return [
    env.DB.prepare(`UPDATE done_marks SET action_id = ?2, action_title = ?3, source = 'site' WHERE suggestion_id = ?1 AND source = 'own'`).bind(suggestionId, actionId, title),
    env.DB.prepare(`UPDATE stories SET action_id = ?2 WHERE action_id = ?1`).bind(ref, actionId),
    ...stories.results.map((s) =>
      enqueue(env, deps, `story-own-action:${s.id}`, {
        op: 'webflow.update',
        collectionId: CMS.stories.id,
        itemId: s.cms_item_id || undefined,
        slug: storySlug(s.id),
        fieldData: { action: actionId },
      }),
    ),
  ];
}

/** A rejected own action is removed for good: its mark (and any story about it) are deleted. */
export async function removeOwn(env: Env, deps: Deps, suggestionId: number) {
  const ref = `${OWN_PREFIX}${suggestionId}`;
  const marks = await env.DB.prepare(`SELECT id, member_id FROM done_marks WHERE suggestion_id = ?1 AND source = 'own'`).bind(suggestionId).all<{ id: number; member_id: number }>();
  const stories = await env.DB.prepare(`SELECT id, cms_item_id, photo_key, video_key, poster_key FROM stories WHERE action_id = ?1`)
    .bind(ref)
    .all<{ id: number; cms_item_id: string | null; photo_key: string | null; video_key: string | null; poster_key: string | null }>();
  if (!marks.results.length && !stories.results.length) return;
  await env.DB.batch([
    ...marks.results.map((m) => env.DB.prepare(`UPDATE pledges SET status = 'open', kept_by_done_mark_id = NULL WHERE kept_by_done_mark_id = ?1`).bind(m.id)),
    env.DB.prepare(`DELETE FROM done_marks WHERE suggestion_id = ?1 AND source = 'own'`).bind(suggestionId),
    ...stories.results.flatMap((s) => storyRemovalStatements(env, deps, s)),
  ]);
  for (const s of stories.results) for (const k of [s.photo_key, s.video_key, s.poster_key]) if (k) await env.MEDIA.delete(k);
  for (const memberId of new Set(marks.results.map((m) => m.member_id))) {
    await forgetRings(env, memberId);
    await recomputeKeeps(env, memberId);
    await refreshActive(env, deps, memberId);
  }
}
