// Active membership (free): a member is Active when they made someone happy in
// at least 4 of the last 5 weeks (weeks run Monday to Sunday, UTC, like the
// weekly dare). Worked out after every "I did this" or undo, and daily, so
// people drop out on time. When the Memberstack "Active" plan is set up
// (MEMBERSTACK_ACTIVE_PLAN_ID in config.ts), Active members also carry that free
// plan in Memberstack. There is never an "Inactive" label: the page only says
// what one more action would do.

import { MEMBERSTACK_ACTIVE_PLAN_ID } from '../config';
import type { Deps, Env } from '../env';
import { callUpstream, iso } from '../http';
import { enqueue, registerTask } from '../queue';
import { weekStart } from './dare';

export const ACTIVE_WEEKS = 5;
export const ACTIVE_NEEDED = 4;
const DAY = 24 * 60 * 60 * 1000;

export interface ActiveView {
  active: boolean;
  /** Oldest first; the last one is the current week. */
  weeks: { start: string; done: boolean }[];
  weeksDone: number;
  needed: number;
  thisWeekDone: boolean;
  /** Weeks with an action still needed to become (or stay) Active, counting this one. */
  toGo: number;
  since: string | null;
}

function weekStarts(now: Date): Date[] {
  const cur = weekStart(now).getTime();
  return Array.from({ length: ACTIVE_WEEKS }, (_, i) => new Date(cur - (ACTIVE_WEEKS - 1 - i) * 7 * DAY));
}

export async function activeView(env: Env, deps: Deps, memberId: number): Promise<ActiveView> {
  const starts = weekStarts(deps.now());
  const rows = await env.DB.prepare(`SELECT done_at FROM done_marks WHERE member_id = ?1 AND done_at >= ?2`)
    .bind(memberId, iso(starts[0]))
    .all<{ done_at: string }>();
  const done = starts.map(() => false);
  for (const r of rows.results) {
    const t = Date.parse(r.done_at);
    for (let i = ACTIVE_WEEKS - 1; i >= 0; i--) if (t >= starts[i].getTime()) { done[i] = true; break; }
  }
  const weeksDone = done.filter(Boolean).length;
  const thisWeekDone = done[ACTIVE_WEEKS - 1];
  // Next week the oldest week drops off: count what stays to say how many more weeks are needed.
  const keep = done.slice(1).filter(Boolean).length;
  const toGo = weeksDone >= ACTIVE_NEEDED ? (keep >= ACTIVE_NEEDED ? 0 : thisWeekDone ? 0 : 1) : ACTIVE_NEEDED - weeksDone;
  const m = await env.DB.prepare(`SELECT active_since FROM members WHERE id = ?1`).bind(memberId).first<{ active_since: string | null }>();
  return {
    active: weeksDone >= ACTIVE_NEEDED,
    weeks: starts.map((s, i) => ({ start: iso(s).slice(0, 10), done: done[i] })),
    weeksDone,
    needed: ACTIVE_NEEDED,
    thisWeekDone,
    toGo,
    since: weeksDone >= ACTIVE_NEEDED ? m?.active_since ?? null : null,
  };
}

/** Works out one member's status and stores it; queues the Memberstack plan change if it flipped. */
export async function refreshActive(env: Env, deps: Deps, memberId: number): Promise<ActiveView> {
  const view = await activeView(env, deps, memberId);
  const row = await env.DB.prepare(`SELECT active, account_id FROM members WHERE id = ?1`).bind(memberId).first<{ active: number; account_id: string }>();
  if (!row) return view;
  const was = row.active === 1;
  if (was !== view.active) {
    const now = iso(deps.now());
    const stmts = [
      env.DB.prepare(`UPDATE members SET active = ?2, active_since = ?3, updated_at = ?4 WHERE id = ?1`).bind(memberId, view.active ? 1 : 0, view.active ? now : null, now),
    ];
    if (MEMBERSTACK_ACTIVE_PLAN_ID && row.account_id.startsWith('mem_')) {
      stmts.push(
        enqueue(env, deps, `active-plan:${memberId}:${view.active ? 'on' : 'off'}:${now.slice(0, 16)}`, {
          op: 'task',
          name: 'memberstack.activePlan',
          target: 'memberstack',
          args: { accountId: row.account_id, on: view.active },
        }, memberId),
      );
    }
    await env.DB.batch(stmts);
    if (view.active) view.since = now;
  }
  return view;
}

/** Daily: members who did anything in the window, or are marked Active, get rechecked. */
export async function refreshAllActive(env: Env, deps: Deps): Promise<{ checked: number; active: number }> {
  const since = iso(weekStarts(deps.now())[0]);
  const rows = await env.DB.prepare(
    `SELECT id FROM members WHERE active = 1 OR id IN (SELECT DISTINCT member_id FROM done_marks WHERE done_at >= ?1)`,
  )
    .bind(since)
    .all<{ id: number }>();
  let active = 0;
  for (const r of rows.results) if ((await refreshActive(env, deps, r.id)).active) active++;
  return { checked: rows.results.length, active };
}

export async function activeCount(env: Env): Promise<number> {
  return (await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE active = 1`).first<{ n: number }>())?.n ?? 0;
}

// Memberstack: add or remove the free "Active" plan (Admin API).
registerTask('memberstack.activePlan', async (env, deps, args) => {
  if (!env.MEMBERSTACK_SECRET_KEY || !MEMBERSTACK_ACTIVE_PLAN_ID) return 'ok';
  const accountId = String(args.accountId);
  const path = args.on ? 'add-plan' : 'remove-plan';
  const res = await callUpstream(deps.fetch, 'memberstack', `https://admin.memberstack.com/members/${encodeURIComponent(accountId)}/${path}`, {
    method: 'POST',
    headers: { 'X-API-KEY': env.MEMBERSTACK_SECRET_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ planId: MEMBERSTACK_ACTIVE_PLAN_ID }),
  });
  // Already on (or already off) is fine.
  if (res.ok || res.status === 409 || res.status === 400) return 'ok';
  throw new Error(`Memberstack ${path} ${res.status}`);
});
