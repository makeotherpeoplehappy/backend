// Your ripple: the people your actions reached, ring by ring.
//
// Ring 1 is your own "I did this" marks. Ring 2 is marks by people who came
// through you: a link you shared (the mark carries your referral, kept 30 days
// in their browser) or an invite they accepted (marks made after joining).
// Ring 3 is the people who came through them, and so on, up to 5 rings.
// Everyone is counted once, in the ring nearest to you (so loops add nothing),
// and only people with marks pass the ripple on: undo a mark and whatever hung
// only on it goes too. Each mark counts 1 person, or the number the member gave
// after "I did this" (never an estimate). Dots carry the action title and who it
// was for (a friend, a stranger…), never names.

import type { Env } from '../env';

export const RINGS = 5;
/** Dots drawn per ring; the rest show as a number. */
export const DOTS_PER_RING = 48;
const CHUNK = 90;

interface Mark {
  id: number;
  member_id: number;
  title: string;
  people: number;
  who: string | null;
  done_at: string;
}

async function marksWhere(env: Env, sql: string, ids: number[]): Promise<Mark[]> {
  const out: Mark[] = [];
  for (let i = 0; i < ids.length; i += CHUNK) {
    const part = ids.slice(i, i + CHUNK);
    const marks = part.map((_, j) => `?${j + 1}`).join(',');
    const r = await env.DB.prepare(sql.replace(/\{ids\}/g, marks)).bind(...part).all<Mark>();
    out.push(...r.results);
  }
  return out;
}

const SELECT = `SELECT d.id, d.member_id, COALESCE(a.title, d.action_title) AS title, COALESCE(d.people, 1) AS people, a.who AS who, d.done_at AS done_at
  FROM done_marks d LEFT JOIN actions a ON a.cms_item_id = d.action_id`;

export async function rippleView(env: Env, memberId: number, fresh = false) {
  const key = `rings:${memberId}`;
  if (!fresh) {
    const cached = await env.CACHE.get(key, 'json');
    if (cached) return cached as Awaited<ReturnType<typeof compute>>;
  }
  const view = await compute(env, memberId);
  await env.CACHE.put(key, JSON.stringify(view), { expirationTtl: 60 });
  return view;
}

async function compute(env: Env, memberId: number) {
  const seen = new Set<number>([memberId]);
  const rings: { marks: number; people: number; members: number; dots: { title: string; who: string | null; at: string }[] }[] = [];
  let frontier = [memberId];
  let level: Mark[] = await marksWhere(env, `${SELECT} WHERE d.member_id IN ({ids}) ORDER BY d.done_at DESC`, frontier);
  for (let ring = 1; ring <= RINGS; ring++) {
    if (!level.length) break;
    rings.push({
      marks: level.length,
      people: level.reduce((n, m) => n + (m.people || 1), 0),
      members: new Set(level.map((m) => m.member_id)).size,
      dots: level.slice(0, DOTS_PER_RING).map((m) => ({ title: m.title, who: firstWho(m.who), at: m.done_at })),
    });
    if (ring === RINGS) break;
    // People with marks in this ring pass it on.
    frontier = [...new Set(level.map((m) => m.member_id))];
    const next = new Map<number, Mark>();
    const viaLink = await marksWhere(env, `${SELECT} WHERE d.parent_member_id IN ({ids}) ORDER BY d.done_at DESC`, frontier);
    const viaInvite = await marksWhere(
      env,
      `${SELECT} JOIN members m ON m.id = d.member_id WHERE m.inviter_id IN ({ids}) AND m.inviter_joined_at IS NOT NULL AND d.done_at >= m.inviter_joined_at ORDER BY d.done_at DESC`,
      frontier,
    );
    for (const m of [...viaLink, ...viaInvite]) if (!seen.has(m.member_id) && !next.has(m.id)) next.set(m.id, m);
    for (const m of next.values()) seen.add(m.member_id);
    level = [...next.values()];
  }
  const later = rings.slice(1);
  return {
    reached: rings.reduce((n, r) => n + r.people, 0),
    /** Your own "I did this" marks. */
    actions: rings[0]?.marks ?? 0,
    /** People who came through you (links or invites) and took an action. */
    friends: later.reduce((n, r) => n + r.members, 0),
    /** The actions they took. */
    theirActions: later.reduce((n, r) => n + r.marks, 0),
    rings,
  };
}

/** The first "who" of an action (stored as a JSON list of slugs), e.g. "friend". */
function firstWho(raw: string | null): string | null {
  try {
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) && typeof list[0] === 'string' ? list[0] : null;
  } catch {
    return null;
  }
}

export async function forgetRings(env: Env, memberId: number): Promise<void> {
  await env.CACHE.delete(`rings:${memberId}`);
}
