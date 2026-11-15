// Resume after sign-in. A signed-out click (or a form whose sign-in expired)
// is saved as an intent before the member goes to sign in. After sign-in the
// site completes the intent once, as the verified member, and is told where
// to return.

import type { Deps, Env } from '../env';
import { HttpError, iso, randomId, safeReturnTo } from '../http';
import type { Member } from '../identity';
import { assertActionId, markDone } from './actions';
import { sendStory, sendSuggestion } from './submissions';

const TTL_SECONDS = 2 * 3600;

// Phase 1 completes these. "like" (Phase 3) and "join" (Phase 4) are added
// with their features; until then they are saved and handed back so the page
// can finish them itself.
const COMPLETABLE = ['done', 'suggestion', 'story'] as const;
const KINDS = [...COMPLETABLE, 'like', 'join'] as const;
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
  if (!KINDS.includes(kind)) throw new HttpError(400, 'invalid_intent', 'That action cannot be saved for later.');
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
  if ((kind === 'done' || kind === 'like' || kind === 'story') && !intent.actionId) {
    throw new HttpError(400, 'invalid_intent', 'That action cannot be saved for later.');
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
  if (!intent) throw new HttpError(410, 'intent_expired', 'That was saved too long ago. Please try again.');
  let result: unknown = null;
  let completed = false;
  if ((COMPLETABLE as readonly string[]).includes(intent.kind)) {
    if (intent.kind === 'done') result = await markDone(env, deps, member, intent.actionId!);
    if (intent.kind === 'suggestion') result = await sendSuggestion(env, deps, member, { text: intent.data?.text });
    if (intent.kind === 'story') result = await sendStory(env, deps, member, { actionId: intent.actionId, text: intent.data?.text, showName: intent.data?.showName });
    completed = true;
  }
  await env.CACHE.delete(`intent:${id}`);
  return { kind: intent.kind, completed, actionId: intent.actionId ?? null, inviteCode: intent.inviteCode ?? null, data: completed ? null : intent.data ?? null, returnTo: intent.returnTo, result };
}
