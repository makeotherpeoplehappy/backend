import { LIMITS, LIMIT_MESSAGES, type LimitKind } from './config';
import type { Deps, Env } from './env';
import { HttpError, callUpstream, iso, json, utcDay } from './http';

// ---------------------------------------------------------------------------
// Origin check: calls are accepted only from the site's own domains.
// ---------------------------------------------------------------------------

export function requestOrigin(req: Request): string | null {
  const origin = req.headers.get('Origin');
  if (origin && origin !== 'null') return origin.replace(/\/$/, '');
  const referer = req.headers.get('Referer');
  if (referer) {
    try {
      return new URL(referer).origin;
    } catch {
      return null;
    }
  }
  return null;
}

export function checkOrigin(req: Request, allowed: Set<string>): void {
  const origin = requestOrigin(req);
  if (origin ? allowed.has(origin) : req.headers.get('Sec-Fetch-Site') === 'same-origin') return;
  throw new HttpError(403, 'origin_not_allowed', 'err-origin-not-allowed');
}

// ---------------------------------------------------------------------------
// Bot protection (Cloudflare Turnstile) for calls that do not need sign-in.
// ---------------------------------------------------------------------------

export async function requireHuman(req: Request, env: Env, deps: Deps, bodyToken?: unknown): Promise<void> {
  const token = req.headers.get('CF-Turnstile-Response') || (typeof bodyToken === 'string' ? bodyToken : '');
  if (!token) throw new HttpError(403, 'bot_check_required', 'err-bot-check-required');
  const form = new FormData();
  form.append('secret', env.TURNSTILE_SECRET_KEY);
  form.append('response', token);
  const ip = req.headers.get('CF-Connecting-IP');
  if (ip) form.append('remoteip', ip);
  const res = await callUpstream(deps.fetch, 'turnstile', 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: form,
  });
  const body = (await res.json().catch(() => ({}))) as { success?: boolean };
  if (!body.success) throw new HttpError(403, 'bot_check_failed', 'err-bot-check-failed');
}

// ---------------------------------------------------------------------------
// Daily limits per member.
// ---------------------------------------------------------------------------

/** Uses one unit of today's allowance, or refuses with a clear message. */
export async function consumeDaily(env: Env, deps: Deps, memberId: number, kind: LimitKind): Promise<void> {
  const day = utcDay(deps.now());
  const res = await env.DB.prepare(
    `INSERT INTO daily_usage (member_id, kind, day, count) VALUES (?1, ?2, ?3, 1)
     ON CONFLICT (member_id, kind, day) DO UPDATE SET count = count + 1 WHERE count < ?4`,
  )
    .bind(memberId, kind, day, LIMITS[kind])
    .run();
  if (!res.meta.changes) {
    throw new HttpError(429, 'daily_limit', LIMIT_MESSAGES[kind]);
  }
}

/** Gives the unit back when the write it was taken for did not happen. */
export async function refundDaily(env: Env, deps: Deps, memberId: number, kind: LimitKind): Promise<void> {
  await env.DB.prepare(
    `UPDATE daily_usage SET count = count - 1 WHERE member_id = ?1 AND kind = ?2 AND day = ?3 AND count > 0`,
  )
    .bind(memberId, kind, utcDay(deps.now()))
    .run();
}

// ---------------------------------------------------------------------------
// One-time request keys: a retried or double-clicked write runs once.
// ---------------------------------------------------------------------------

const KEY_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

export function idempotencyKey(req: Request): string {
  const key = req.headers.get('Idempotency-Key') || '';
  if (!KEY_PATTERN.test(key)) {
    throw new HttpError(400, 'idempotency_key_required', 'err-idempotency-key-required');
  }
  return key;
}

/**
 * Runs `fn` once per (scope, key). A repeat of a finished request gets the
 * stored answer; a repeat while the first is still running is told to retry.
 */
export async function once(
  env: Env,
  deps: Deps,
  scope: string,
  key: string,
  route: string,
  fn: () => Promise<Response>,
): Promise<Response> {
  const claim = await env.DB.prepare(
    `INSERT INTO request_keys (scope, key, route, status, created_at) VALUES (?1, ?2, ?3, 'pending', ?4)
     ON CONFLICT (scope, key) DO NOTHING`,
  )
    .bind(scope, key, route, iso(deps.now()))
    .run();

  if (!claim.meta.changes) {
    const prior = await env.DB.prepare(`SELECT route, status, response_status, response_body FROM request_keys WHERE scope = ?1 AND key = ?2`)
      .bind(scope, key)
      .first<{ route: string; status: string; response_status: number | null; response_body: string | null }>();
    if (prior && prior.route !== route) {
      throw new HttpError(422, 'idempotency_key_reused', 'err-idempotency-key-reused');
    }
    if (prior?.status === 'done' && prior.response_status !== null) {
      return new Response(prior.response_body, {
        status: prior.response_status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Idempotent-Replay': 'true' },
      });
    }
    return json({ error: 'in_progress' }, 409, { 'Retry-After': '1' }); // the site retries; nothing is shown
  }

  let res: Response;
  try {
    res = await fn();
  } catch (e) {
    // Nothing was stored, so the same key may be used again.
    await env.DB.prepare(`DELETE FROM request_keys WHERE scope = ?1 AND key = ?2`).bind(scope, key).run();
    throw e;
  }
  const body = await res.clone().text();
  if (res.status >= 500 || res.status === 401 || res.status === 403) {
    await env.DB.prepare(`DELETE FROM request_keys WHERE scope = ?1 AND key = ?2`).bind(scope, key).run();
  } else {
    await env.DB.prepare(`UPDATE request_keys SET status = 'done', response_status = ?3, response_body = ?4 WHERE scope = ?1 AND key = ?2`)
      .bind(scope, key, res.status, body)
      .run();
  }
  return res;
}
