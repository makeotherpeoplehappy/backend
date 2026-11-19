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
import { memberTally, PEOPLE_ANSWERS } from './actions';
import { recomputeKeeps } from './pledges';
import { forgetRings, rippleView } from './rings';
import { cleanText, createSuggestion, similarity, titleFrom } from './submissions';

export const OWN_PREFIX = 'own-';
const MAX_OWN = 140;
const WHO = new Set(Object.values(CMS.actions.whoSlugs));

export async function logOwnAction(env: Env, deps: Deps, member: Member, body: { text?: unknown; who?: unknown; people?: unknown }) {
  const text = cleanText(body.text, MAX_OWN);
  if (text.length < 3) throw new HttpError(400, 'empty_own', 'err-own-empty');
  const who = typeof body.who === 'string' && body.who ? body.who : null;
  if (who && !WHO.has(who)) throw new HttpError(400, 'invalid_who', 'err-own-who');
  const people = body.people === undefined || body.people === null || body.people === '' ? 1 : typeof body.people === 'string' ? PEOPLE_ANSWERS[body.people] : undefined;
  if (!people) throw new HttpError(400, 'invalid_people', 'err-invalid-people');

  // One of your own a day counts. The site's actions have no limit.
  const now = iso(deps.now());
  const today = await env.DB.prepare(`SELECT 1 AS x FROM done_marks WHERE member_id = ?1 AND suggestion_id IS NOT NULL AND substr(done_at, 1, 10) = ?2 LIMIT 1`)
    .bind(member.id, now.slice(0, 10))
    .first();
  if (today) throw new HttpError(429, 'own_daily', 'err-own-daily');

  const id = await createSuggestion(env, deps, member, {
    text,
    kind: 'own',
    who: who ? JSON.stringify([who]) : null,
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
  return { id, active, tally: await memberTally(env, member.id), rippleView: await rippleView(env, member.id, true) };
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

/** Once an action made from an own-action suggestion is published, its marks move to it and count in public. */
export function relinkOwnMarks(env: Env, suggestionId: number, actionId: string, title: string): D1PreparedStatement {
  return env.DB.prepare(`UPDATE done_marks SET action_id = ?2, action_title = ?3, source = 'site' WHERE suggestion_id = ?1 AND source = 'own'`).bind(
    suggestionId,
    actionId,
    title,
  );
}
