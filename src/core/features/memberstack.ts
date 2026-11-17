// Memberstack webhook (Developer > Webhooks in Memberstack): keeps a member's
// email and first name in step, and removes their data when they are deleted
// in Memberstack. Deliveries are signed by Svix; the signing secret is
// MEMBERSTACK_WEBHOOK_SECRET.

import type { Deps, Env } from '../env';
import { HttpError, iso, json, timingSafeEqual } from '../http';
import { memberstackMember } from '../identity';
import { deleteMemberData } from './account';

const TOLERANCE_SECONDS = 5 * 60;

function bytesOf(b64: string): Uint8Array<ArrayBuffer> {
  const s = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(s.length));
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function base64Of(buf: ArrayBuffer): string {
  let s = '';
  for (const b of new Uint8Array(buf)) s += String.fromCharCode(b);
  return btoa(s);
}

/** Svix's signature: base64 HMAC-SHA256 of "id.timestamp.body", with the secret after "whsec_". */
export async function svixSignature(secret: string, id: string, timestamp: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', bytesOf(secret.replace(/^whsec_/, '')), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return base64Of(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${id}.${timestamp}.${body}`)));
}

export async function memberstackWebhook(env: Env, deps: Deps, req: Request): Promise<Response> {
  if (!env.MEMBERSTACK_WEBHOOK_SECRET) return json({ error: 'not_configured' }, 503);
  const id = req.headers.get('svix-id') || '';
  const timestamp = req.headers.get('svix-timestamp') || '';
  const signatures = (req.headers.get('svix-signature') || '').split(' ').map((s) => s.split(',')[1]).filter(Boolean);
  const body = await req.text();
  const age = Math.abs(deps.now().getTime() / 1000 - Number(timestamp));
  if (!id || !signatures.length || !Number.isFinite(age) || age > TOLERANCE_SECONDS) throw new HttpError(401, 'unauthorized', 'Not authorised.');
  const expected = await svixSignature(env.MEMBERSTACK_WEBHOOK_SECRET, id, timestamp, body);
  if (!signatures.some((s) => timingSafeEqual(s, expected))) throw new HttpError(401, 'unauthorized', 'Not authorised.');
  // Each delivery is handled once, even when Svix retries it.
  const seen = `ms-webhook:${id}`;
  if (await env.CACHE.get(seen)) return json({ ok: true, duplicate: true });

  let event: { event?: string; type?: string; payload?: Record<string, unknown>; data?: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Invalid body.');
  }
  const kind = String(event.event || event.type || '');
  const p = (event.payload || event.data || {}) as { id?: string; member?: { id?: string } };
  const memberId = p.id || p.member?.id || '';
  let result: string = 'ignored';
  if (/^mem_/.test(memberId)) {
    const row = await env.DB.prepare(`SELECT id FROM members WHERE account_id = ?1 AND deleted_at IS NULL`).bind(memberId).first<{ id: number }>();
    if (row && /deleted/.test(kind)) {
      await deleteMemberData(env, deps, row.id);
      result = 'deleted';
    } else if (row && /updated/.test(kind)) {
      // Read the member fresh rather than trusting the payload's shape.
      const account = await memberstackMember(env, deps, memberId);
      if (account) {
        await env.DB.prepare(`UPDATE members SET first_name = COALESCE(?2, first_name), email = COALESCE(?3, email), updated_at = ?4 WHERE id = ?1`)
          .bind(row.id, account.firstName, account.email, iso(deps.now()))
          .run();
        result = 'updated';
      }
    }
  }
  await env.CACHE.put(seen, '1', { expirationTtl: 7 * 86_400 });
  return json({ ok: true, result });
}
