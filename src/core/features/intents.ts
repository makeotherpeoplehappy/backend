// Resume after sign-in. A signed-out click (or a form whose sign-in expired)
// is saved as an intent before the member goes to sign in. After sign-in the
// site completes the intent once, as the verified member, and is told where
// to return.

import type { Deps, Env } from '../env';
import { HttpError, iso, randomId, safeReturnTo } from '../http';
import type { Member } from '../identity';
import { assertActionId, markDone, setLike } from './actions';
import { sendSuggestion } from './submissions';
import { joinInvite } from './ripple';

const TTL_SECONDS = 2 * 3600;

// These are completed by the backend. A story is handed back with its text,
// so the story form opens again with the draft (it needs a consent tick).
const COMPLETABLE = ['done', 'like', 'suggestion', 'join'] as const;
const KINDS = [...COMPLETABLE, 'story', 'return'] as const;
type Kind = (typeof KINDS)[number];

export interface Intent {
  kind: Kind;
  actionId?: string;
  inviteCode?: string;
  /** Typed text kept across sign-in (suggestion or story). */
  data?: { text?: string; showName?: boolean };
  returnTo: string | null;
  createdAt: string;
}

const ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

export async function createIntent(env: Env, deps: Deps, body: Record<string, unknown>, origins: Set<string>) {
  const kind = body.kind as Kind;
  if (!KINDS.includes(kind)) throw new HttpError(400, 'invalid_intent', 'err-invalid-intent');
  const intent: Intent = { kind, returnTo: safeReturnTo(body.returnTo, origins), createdAt: iso(deps.now()) };
  if (typeof body.actionId === 'string') {
    assertActionId(body.actionId);
    intent.actionId = body.actionId;
  }
  if (typeof body.inviteCode === 'string' && /^[A-Za-z0-9]{3,32}$/.test(body.inviteCode)) intent.inviteCode = body.inviteCode;
  const data = (body.data || {}) as Record<string, unknown>;
  if (typeof data.text === 'string' || typeof data.showName === 'boolean') {
    intent.data = {
      ...(typeof data.text === 'string' ? { text: data.text.slice(0, 5000) } : {}),
      ...(typeof data.showName === 'boolean' ? { showName: data.showName } : {}),
    };
  }
  if (kind === 'join' && !intent.inviteCode) throw new HttpError(400, 'invalid_intent', 'err-invalid-intent-invite');
  if ((kind === 'done' || kind === 'like' || kind === 'story') && !intent.actionId) {
    throw new HttpError(400, 'invalid_intent', 'err-invalid-intent');
  }
  const id = randomId(16);
  await env.CACHE.put(`intent:${id}`, JSON.stringify(intent), { expirationTtl: TTL_SECONDS });
  return { id, expiresInSeconds: TTL_SECONDS };
}

export async function readIntent(env: Env, id: string): Promise<Intent | null> {
  if (!ID_PATTERN.test(id)) return null;
  return (await env.CACHE.get(`intent:${id}`, 'json')) as Intent | null;
}

/** Completes the saved action as the member. Run through once() by the router. */
export async function completeIntent(env: Env, deps: Deps, member: Member, id: string) {
  const intent = await readIntent(env, id);
  if (!intent) throw new HttpError(410, 'intent_expired', 'err-intent-expired');
  let result: unknown = null;
  let completed = false;
  if ((COMPLETABLE as readonly string[]).includes(intent.kind)) {
    try {
      if (intent.kind === 'done') result = await markDone(env, deps, member, intent.actionId!);
      if (intent.kind === 'like') result = await setLike(env, deps, member, intent.actionId!, true);
      if (intent.kind === 'suggestion') result = await sendSuggestion(env, deps, member, { text: intent.data?.text });
      if (intent.kind === 'join') result = await joinInvite(env, deps, member, intent.inviteCode || '');
    } catch (e) {
      // Already done today, or it is the member's own invite: nothing more to do.
      if (!(e instanceof HttpError) || !['done_today', 'own_invite'].includes(e.code)) throw e;
      result = { note: e.code, message: e.message };
    }
    completed = true;
  }
  await env.CACHE.delete(`intent:${id}`);
  return { kind: intent.kind, completed, actionId: intent.actionId ?? null, inviteCode: intent.inviteCode ?? null, data: completed ? null : intent.data ?? null, returnTo: intent.returnTo, result };
}
