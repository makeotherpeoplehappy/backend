// Outbox queue for writes to Webflow, Shopify and email. A member's request
// saves its record and its queued write together, so nothing they send is
// lost if a service is down; the queue retries until the write succeeds.

import type { Deps, Env } from './env';
import { reportError } from './errors';
import { sendEmail, type EmailMessage } from './email';
import { UpstreamError, iso } from './http';
import * as webflow from './webflow';
import { writeDropSignupToShopify } from './features/drops';

export type Target = 'webflow' | 'shopify' | 'email';

export type QueuedOp =
  | {
      op: 'webflow.create';
      collectionId: string;
      fieldData: Record<string, unknown> & { name: string; slug: string };
      isDraft?: boolean;
      /** Row that receives the new CMS item ID. */
      saveIdTo?: { table: 'suggestions' | 'stories'; id: number };
    }
  | { op: 'webflow.update'; collectionId: string; itemId?: string; slug?: string; fieldData: Record<string, unknown> }
  | { op: 'webflow.delete'; collectionId: string; itemId?: string; slug?: string; afterCreate?: string }
  | { op: 'webflow.updateLive'; collectionId: string; itemId: string; fieldData: Record<string, unknown> }
  | { op: 'webflow.publish'; collectionId: string; itemId?: string; slug?: string; afterCreate?: string }
  | { op: 'webflow.removeFromLive'; collectionId: string; itemId?: string; slug?: string; afterCreate?: string }
  | { op: 'email.send'; message: EmailMessage }
  | { op: 'shopify.dropSignup'; email: string; firstName: string | null; tag: string }
  /** A named piece of feature work, retried like any other write. */
  | { op: 'task'; name: string; target: Target; args: Record<string, unknown> };

type TaskFn = (env: Env, deps: Deps, args: Record<string, unknown>) => Promise<'ok' | 'defer' | void>;
const TASKS = new Map<string, TaskFn>();

/** Features register the work they queue, so the queue needs no import of them. */
export function registerTask(name: string, fn: TaskFn): void {
  TASKS.set(name, fn);
}

const TARGET_OF: Record<Exclude<QueuedOp['op'], 'task'>, Target> = {
  'webflow.create': 'webflow',
  'webflow.update': 'webflow',
  'webflow.delete': 'webflow',
  'webflow.updateLive': 'webflow',
  'webflow.publish': 'webflow',
  'webflow.removeFromLive': 'webflow',
  'email.send': 'email',
  'shopify.dropSignup': 'shopify',
};

const targetOf = (op: QueuedOp): Target => (op.op === 'task' ? op.target : TARGET_OF[op.op]);

// Writes per drain run, per service. Webflow's CMS API allows 60 requests a
// minute on most plans; a create can take two requests.
const PER_RUN_BUDGET: Record<Target, number> = { webflow: 25, shopify: 20, email: 20 };
const MAX_ATTEMPTS = 25;
const LOCK_SECONDS = 120;

/** A statement that queues a write; batch it with the record it belongs to. */
export function enqueue(env: Env, deps: Deps, dedupeKey: string, op: QueuedOp, memberId?: number | null): D1PreparedStatement {
  const now = iso(deps.now());
  return env.DB.prepare(
    `INSERT INTO outbox (target, op, payload, dedupe_key, member_id, status, attempts, next_attempt_at, created_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', 0, ?6, ?6, ?6)
     ON CONFLICT (dedupe_key) DO NOTHING`,
  ).bind(targetOf(op), op.op, JSON.stringify(op), dedupeKey, memberId ?? null, now);
}

interface OutboxRow {
  id: number;
  target: Target;
  op: string;
  payload: string;
  dedupe_key: string;
  attempts: number;
}

export interface DrainResult {
  done: number;
  retried: number;
  dead: number;
  skipped: number;
}

/** Runs due queued writes until the limit, the deadline or every budget is used. */
export async function drain(env: Env, deps: Deps, opts: { limit?: number; deadlineMs?: number } = {}): Promise<DrainResult> {
  const limit = opts.limit ?? 50;
  const started = Date.now();
  const deadline = opts.deadlineMs ?? 20_000;
  const result: DrainResult = { done: 0, retried: 0, dead: 0, skipped: 0 };
  const budget = { ...PER_RUN_BUDGET };
  const now = () => iso(deps.now());

  const paused = new Map<string, string>();
  const ps = await env.DB.prepare(`SELECT target, paused_until FROM rate_state WHERE paused_until > ?1`).bind(now()).all<{ target: string; paused_until: string }>();
  for (const p of ps.results) paused.set(p.target, p.paused_until);

  const due = await env.DB.prepare(
    `SELECT id, target, op, payload, dedupe_key, attempts FROM outbox
     WHERE (status = 'pending' AND next_attempt_at <= ?1) OR (status = 'running' AND locked_until < ?1)
     ORDER BY next_attempt_at, id LIMIT ?2`,
  )
    .bind(now(), limit)
    .all<OutboxRow>();

  for (const row of due.results) {
    if (Date.now() - started > deadline) break;
    if (paused.has(row.target) || budget[row.target] <= 0) {
      result.skipped++;
      continue;
    }
    const lockedUntil = iso(new Date(deps.now().getTime() + LOCK_SECONDS * 1000));
    const claim = await env.DB.prepare(
      `UPDATE outbox SET status = 'running', locked_until = ?2, updated_at = ?3
       WHERE id = ?1 AND (status = 'pending' OR (status = 'running' AND locked_until < ?3))`,
    )
      .bind(row.id, lockedUntil, now())
      .run();
    if (!claim.meta.changes) continue; // another run took it
    budget[row.target]--;

    try {
      const op = JSON.parse(row.payload) as QueuedOp;
      const outcome = await run(env, deps, op, row);
      if (outcome === 'defer') {
        await reschedule(env, deps, row, 30, 'waiting for an earlier write', false);
        result.retried++;
        continue;
      }
      // Once delivered, personal details are not kept in the queue.
      await env.DB.prepare(
        `UPDATE outbox SET status = 'done', locked_until = NULL, last_error = NULL, updated_at = ?2,
           payload = CASE WHEN op IN ('shopify.dropSignup', 'email.send') THEN '{"op":"' || op || '","redacted":true}' ELSE payload END
         WHERE id = ?1`,
      )
        .bind(row.id, now())
        .run();
      result.done++;
    } catch (e) {
      const err = e as Error;
      const upstream = e instanceof UpstreamError ? e : null;
      if (upstream?.status === 429) {
        const wait = Math.max(upstream.retryAfterSeconds ?? 60, 1);
        const until = iso(new Date(deps.now().getTime() + wait * 1000));
        await env.DB.prepare(`INSERT INTO rate_state (target, paused_until) VALUES (?1, ?2) ON CONFLICT (target) DO UPDATE SET paused_until = excluded.paused_until`)
          .bind(row.target, until)
          .run();
        paused.set(row.target, until);
        await reschedule(env, deps, row, wait, err.message, false);
        result.retried++;
        continue;
      }
      // A service refusing the write (4xx) will not change its mind; anything
      // else (outage, timeout, our own bug) is retried with backoff.
      const permanent = upstream ? !upstream.retryable : false;
      const attempts = row.attempts + 1;
      if (!upstream && !permanent && attempts === 1) {
        await reportError(env, deps, { where: `queue ${row.op} (will retry)`, error: err, details: { outboxId: row.id, dedupeKey: row.dedupe_key } });
      }
      if (permanent || attempts >= MAX_ATTEMPTS) {
        await env.DB.prepare(`UPDATE outbox SET status = 'dead', attempts = ?2, locked_until = NULL, last_error = ?3, updated_at = ?4 WHERE id = ?1`)
          .bind(row.id, attempts, err.message.slice(0, 2000), now())
          .run();
        result.dead++;
        await reportError(env, deps, {
          where: `queue ${row.op}`,
          error: err,
          details: { outboxId: row.id, dedupeKey: row.dedupe_key, attempts, permanent, payload: redact(row.payload) },
        });
      } else {
        await reschedule(env, deps, row, backoffSeconds(attempts), err.message, true);
        result.retried++;
      }
    }
  }
  return result;
}

function backoffSeconds(attempts: number): number {
  // 30s, 1m, 2m, 4m ... capped at 6 hours.
  return Math.min(30 * 2 ** (attempts - 1), 6 * 3600);
}

async function reschedule(env: Env, deps: Deps, row: OutboxRow, seconds: number, error: string, countAttempt: boolean): Promise<void> {
  const next = iso(new Date(deps.now().getTime() + seconds * 1000));
  await env.DB.prepare(
    `UPDATE outbox SET status = 'pending', attempts = attempts + ?2, next_attempt_at = ?3, locked_until = NULL, last_error = ?4, updated_at = ?5 WHERE id = ?1`,
  )
    .bind(row.id, countAttempt ? 1 : 0, next, error.slice(0, 2000), iso(deps.now()))
    .run();
}

function redact(payload: string): string {
  return payload.replace(/"email"\s*:\s*"[^"]*"/g, '"email":"[hidden]"').replace(/"to"\s*:\s*"[^"]*"/g, '"to":"[hidden]"').slice(0, 1500);
}

async function waitingFor(env: Env, dedupeKey?: string): Promise<boolean> {
  if (!dedupeKey) return false;
  const create = await env.DB.prepare(`SELECT status FROM outbox WHERE dedupe_key = ?1`).bind(dedupeKey).first<{ status: string }>();
  return !!create && (create.status === 'pending' || create.status === 'running');
}

async function itemIdOf(env: Env, deps: Deps, op: { collectionId: string; itemId?: string; slug?: string }): Promise<string | undefined> {
  return op.itemId || (op.slug ? (await webflow.findItemBySlug(env, deps, op.collectionId, op.slug))?.id : undefined);
}

async function run(env: Env, deps: Deps, op: QueuedOp, row: OutboxRow): Promise<'ok' | 'defer'> {
  switch (op.op) {
    case 'webflow.updateLive':
      await webflow.updateLiveItem(env, deps, op.collectionId, op.itemId, op.fieldData);
      return 'ok';
    case 'webflow.publish': {
      if (await waitingFor(env, op.afterCreate)) return 'defer';
      const id = await itemIdOf(env, deps, op);
      if (id) await webflow.publishItems(env, deps, op.collectionId, [id]);
      return 'ok';
    }
    case 'webflow.removeFromLive': {
      if (await waitingFor(env, op.afterCreate)) return 'defer';
      const id = await itemIdOf(env, deps, op);
      if (id) await webflow.removeFromLive(env, deps, op.collectionId, id);
      return 'ok';
    }
    case 'task': {
      const fn = TASKS.get(op.name);
      if (!fn) throw new Error(`Unknown queued task ${op.name}`);
      return (await fn(env, deps, op.args)) === 'defer' ? 'defer' : 'ok';
    }
    case 'webflow.create': {
      const item = await webflow.createItem(env, deps, op.collectionId, op.fieldData, op.isDraft ?? true);
      if (op.saveIdTo) {
        const table = op.saveIdTo.table === 'stories' ? 'stories' : 'suggestions';
        await env.DB.prepare(`UPDATE ${table} SET cms_item_id = ?2 WHERE id = ?1`).bind(op.saveIdTo.id, item.id).run();
      }
      return 'ok';
    }
    case 'webflow.update': {
      const itemId = op.itemId || (op.slug ? (await webflow.findItemBySlug(env, deps, op.collectionId, op.slug))?.id : undefined);
      if (itemId) await webflow.updateItem(env, deps, op.collectionId, itemId, op.fieldData);
      return 'ok';
    }
    case 'webflow.delete': {
      if (op.afterCreate) {
        // Wait for a create of the same item that is still queued or running,
        // so the delete cannot run first and leave the item behind.
        const create = await env.DB.prepare(`SELECT status FROM outbox WHERE dedupe_key = ?1`).bind(op.afterCreate).first<{ status: string }>();
        if (create && (create.status === 'pending' || create.status === 'running')) return 'defer';
      }
      const itemId = op.itemId || (op.slug ? (await webflow.findItemBySlug(env, deps, op.collectionId, op.slug))?.id : undefined);
      if (itemId) await webflow.deleteItem(env, deps, op.collectionId, itemId);
      return 'ok';
    }
    case 'email.send':
      await sendEmail(env, deps, op.message, row.dedupe_key);
      return 'ok';
    case 'shopify.dropSignup':
      await writeDropSignupToShopify(env, deps, op);
      return 'ok';
  }
}
