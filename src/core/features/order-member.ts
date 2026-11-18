// The member on a Shopify order started from this site's checkout: their id
// with a signature, so a cart made anywhere else cannot claim to be them.

import type { Env } from '../env';
import { base64url, hmac } from '../http';

/** Order attribute (hidden at checkout: it starts with "_"). */
export const ORDER_MEMBER_ATTRIBUTE = '_hf_member';

export async function memberTag(env: Env, memberId: number): Promise<string> {
  return `${memberId}.${base64url(await hmac(env.LINK_SECRET, `order-member:${memberId}`)).slice(0, 16)}`;
}
export async function memberFromTag(env: Env, tag: unknown): Promise<number | null> {
  const m = /^(\d{1,12})\.([\w-]{16})$/.exec(String(tag || ''));
  if (!m) return null;
  return (await memberTag(env, Number(m[1]))) === `${m[1]}.${m[2]}` ? Number(m[1]) : null;
}

