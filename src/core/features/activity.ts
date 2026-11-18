// Live activity line on the home page: the last few times someone, anywhere,
// made another person happy. Anonymous: no names, no accounts, only the kind of
// person they made happy (from the action's "who") and, when the member chose
// one, their home area. Cached for a minute so the home page never waits on it.

import type { Deps, Env } from '../env';
import { iso } from '../http';

const CACHE_KEY = 'activity:recent';
const WINDOW_DAYS = 7;
const LIMIT = 8;

export type ActivityItem = { at: string; who: string | null; place: string | null };

export async function recentActivity(env: Env, deps: Deps): Promise<{ items: ActivityItem[] }> {
  const cached = (await env.CACHE.get(CACHE_KEY, 'json')) as { items: ActivityItem[] } | null;
  if (cached) return cached;
  const since = iso(new Date(deps.now().getTime() - WINDOW_DAYS * 24 * 60 * 60 * 1000));
  const rows = await env.DB.prepare(
    `SELECT d.done_at AS at, a.who AS who, m.home_area AS place
     FROM done_marks d
     JOIN actions a ON a.cms_item_id = d.action_id
     JOIN members m ON m.id = d.member_id
     WHERE d.source = 'site' AND a.status = 'published' AND a.hidden = 0 AND d.done_at >= ?1
     ORDER BY d.done_at DESC LIMIT ?2`,
  )
    .bind(since, LIMIT)
    .all<{ at: string; who: string | null; place: string | null }>();
  const items = rows.results.map((r) => ({ at: r.at, who: singleWho(r.who), place: r.place || null }));
  const out = { items };
  await env.CACHE.put(CACHE_KEY, JSON.stringify(out), { expirationTtl: 60 });
  return out;
}

/** One kind of person, or null when the action names none or several (the line then says "someone"). */
function singleWho(raw: string | null): string | null {
  try {
    const list = JSON.parse(raw || '[]') as string[];
    return list.length === 1 ? list[0] : null;
  } catch {
    return null;
  }
}
