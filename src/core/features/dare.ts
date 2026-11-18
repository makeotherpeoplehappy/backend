// Weekly dare: one action for everyone each week, with a live count.
//
// A dare week runs Monday 00:00 to Sunday 23:59, UTC, the same for everyone.
// This week's dare is the published action whose "Weekly dare from" date falls
// in this week (and has arrived), skipping hidden and location-specific
// actions. If two share the same date, the first by title wins, and the Lab
// shows a warning. The count is people (not clicks) who marked it done this
// week, signed in or not; below 10 the page shows encouraging words instead.

import { COUNT_THRESHOLD } from '../config';
import type { Deps, Env } from '../env';
import { iso } from '../http';

const DAY = 24 * 60 * 60 * 1000;
const CACHE_KEY = 'dare:current';

/** Monday 00:00 UTC of the week that holds `d`. */
export function weekStart(d: Date): Date {
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - day));
}

interface DareRow {
  actionId: string;
  slug: string;
  title: string;
  shortAnswer: string | null;
  from: string;
  hidden: number;
  locationSpecific: number;
}

async function weekRows(env: Env, start: Date, end: Date): Promise<DareRow[]> {
  const r = await env.DB.prepare(
    `SELECT cms_item_id AS actionId, slug, title, short_answer AS shortAnswer, weekly_dare_from AS "from", hidden, location_specific AS locationSpecific
     FROM actions WHERE status = 'published' AND weekly_dare_from >= ?1 AND weekly_dare_from < ?2
     ORDER BY weekly_dare_from DESC, title ASC`,
  )
    .bind(iso(start), iso(end))
    .all<DareRow>();
  return r.results;
}

const usable = (r: DareRow) => !r.hidden && !r.locationSpecific;

/** This week's dare and its count, or null when none is set. Cached briefly; a new mark clears it. */
export async function currentDare(env: Env, deps: Deps) {
  const now = deps.now();
  const start = weekStart(now);
  const cached = (await env.CACHE.get(CACHE_KEY, 'json')) as { weekStart: string; at: number; dare: unknown } | null;
  if (cached && cached.weekStart === iso(start) && now.getTime() - cached.at < 30_000) return { dare: cached.dare };
  const rows = (await weekRows(env, start, new Date(now.getTime() + 1))).filter(usable);
  const pick = rows[0];
  let dare = null;
  if (pick) {
    const c = await env.DB.prepare(`SELECT COUNT(DISTINCT member_id) AS n FROM done_marks WHERE action_id = ?1 AND done_at >= ?2`)
      .bind(pick.actionId, iso(start))
      .first<{ n: number }>();
    const n = c?.n ?? 0;
    dare = {
      actionId: pick.actionId,
      slug: pick.slug,
      title: pick.title,
      shortAnswer: pick.shortAnswer,
      count: n >= COUNT_THRESHOLD ? n : null,
      weekStart: iso(start),
      weekEnd: iso(new Date(start.getTime() + 7 * DAY - 1000)),
    };
  }
  await env.CACHE.put(CACHE_KEY, JSON.stringify({ weekStart: iso(start), at: now.getTime(), dare }), { expirationTtl: 60 });
  return { dare };
}

export async function forgetDare(env: Env): Promise<void> {
  await env.CACHE.delete(CACHE_KEY);
}

/** Problems with this week's and next week's dares, for the Lab. */
export async function dareWarnings(env: Env, deps: Deps): Promise<string[]> {
  const out: string[] = [];
  const start = weekStart(deps.now());
  const weeks: [string, Date][] = [
    ['This week', start],
    ['Next week', new Date(start.getTime() + 7 * DAY)],
  ];
  for (const [label, from] of weeks) {
    const rows = await weekRows(env, from, new Date(from.getTime() + 7 * DAY));
    for (const r of rows) {
      if (r.locationSpecific) out.push(`${label}: "${r.title}" is set as the weekly dare but is location-specific, so it is skipped. Pick an action that works anywhere.`);
      else if (r.hidden) out.push(`${label}: "${r.title}" is set as the weekly dare but is hidden, so it is skipped.`);
    }
    const ok = rows.filter(usable);
    const top = ok[0];
    const tied = top ? ok.filter((r) => r.from.slice(0, 10) === top.from.slice(0, 10)) : [];
    if (tied.length > 1) out.push(`${label}: ${tied.map((r) => `"${r.title}"`).join(' and ')} share the same weekly dare date. Showing "${top.title}".`);
    if (label === 'This week' && !ok.length) out.push('This week: no weekly dare is set, so the home page hides the dare block.');
  }
  return out;
}
