import { EMAIL_KINDS, type EmailKind } from './config';
import type { Deps, Env } from './env';
import { UpstreamError, base64url, callUpstream, hmac, retryAfterSeconds, timingSafeEqual } from './http';
import type { Member } from './identity';
export interface EmailMessage {
  to: string;
  /** A plain-text email (staff emails), or... */
  subject?: string;
  text?: string;
  /** ...a published Resend template (member emails), by alias, with its variables. */
  template?: { id: string; variables: Record<string, string | number> };
  headers?: Record<string, string>;
  tags?: { name: string; value: string }[];
}

/** Resend templates take every variable as text (a number is refused with 422), so numbers go as strings. */
function textVariables(t: NonNullable<EmailMessage['template']>) {
  return { id: t.id, variables: Object.fromEntries(Object.entries(t.variables).map(([k, v]) => [k, String(v)])) };
}

/** Sends one email through Resend: plain text, or a Resend template (its wording is edited in Resend). */
export async function sendEmail(env: Env, deps: Deps, msg: EmailMessage, idempotencyKey?: string): Promise<void> {
  const res = await callUpstream(deps.fetch, 'email', 'https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {}),
    },
    body: JSON.stringify(
      msg.template
        ? { from: env.EMAIL_FROM, to: [msg.to], template: textVariables(msg.template), headers: msg.headers, tags: msg.tags }
        : { from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, headers: msg.headers, tags: msg.tags },
    ),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UpstreamError('email', res.status, `Resend failed (${res.status}): ${text.slice(0, 300)}`, retryAfterSeconds(res));
  }
}

// ---------------------------------------------------------------------------
// The member emails. Their wording and design live in Resend, as published
// templates (Resend > Templates); the backend picks the template for the
// case and fills in the details. Variables: GREETING_NAME (Resend falls back
// to "there"), LINK_URL, UNSUB_URL, and NAME / NAMES / COUNT / ACTION_TITLE.
// ---------------------------------------------------------------------------

export interface MemberEmailVars {
  /** invite_summary: first names of the people who joined today. */
  joinedNames?: string[];
  actionTitle?: string;
  actionUrl?: string;
}

// "Ben, Cleo and Dan" (British style, no comma before "and", as the emails always had).
const listOf = (names: string[]) => new Intl.ListFormat('en-GB', { style: 'long', type: 'conjunction' }).format(names);

/** The Resend template alias and variables for one member email. */
export function memberTemplate(kind: EmailKind, member: Member, v: MemberEmailVars): { id: string; variables: Record<string, string | number> } {
  const variables: Record<string, string | number> = { LINK_URL: v.actionUrl || '' };
  if (member.first_name) variables.GREETING_NAME = member.first_name;
  const titled = (alias: string) => {
    if (!v.actionTitle) return `${alias}-untitled`;
    variables.ACTION_TITLE = v.actionTitle;
    return alias;
  };
  switch (kind) {
    case 'invite_summary': {
      const names = (v.joinedNames || []).filter(Boolean);
      if (names.length > 1) {
        variables.NAMES = listOf(names);
        variables.COUNT = names.length;
        return { id: titled('hf-invite-joined-many'), variables };
      }
      variables.NAME = names[0] || '';
      return { id: titled('hf-invite-joined-one'), variables };
    }
    case 'story_approved':
      return { id: titled('hf-story-live'), variables };
    case 'suggestion_live':
      return { id: titled('hf-suggestion-live'), variables };
    case 'pledge_reminder':
      return { id: 'hf-pledge-reminder', variables };
  }
}

export function wantsEmail(member: Member, kind: EmailKind): boolean {
  return Number(member[EMAIL_KINDS[kind]]) === 1 && !!member.email;
}

/** Builds a member email with a one-click unsubscribe link, or null if the member turned it off. */
export async function memberEmail(env: Env, member: Member, kind: EmailKind, vars: MemberEmailVars, baseUrl: string): Promise<EmailMessage | null> {
  if (!wantsEmail(member, kind)) return null;
  const offUrl = `${baseUrl}/api/notifications/off?t=${await signUnsubscribe(env, member.id, kind)}`;
  const template = memberTemplate(kind, member, vars);
  template.variables.UNSUB_URL = offUrl;
  return {
    to: member.email!,
    template,
    tags: [{ name: 'kind', value: kind }],
    headers: { 'List-Unsubscribe': `<${offUrl}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
  };
}

export async function signUnsubscribe(env: Env, memberId: number, kind: EmailKind): Promise<string> {
  const payload = `${memberId}.${kind}`;
  const sig = base64url(await hmac(env.LINK_SECRET, `unsub:${payload}`));
  return `${payload}.${sig}`;
}

export async function verifyUnsubscribe(env: Env, token: string): Promise<{ memberId: number; kind: EmailKind } | null> {
  const m = /^(\d+)\.([a-z_]+)\.([A-Za-z0-9_-]+)$/.exec(token || '');
  if (!m || !(m[2] in EMAIL_KINDS)) return null;
  const expected = base64url(await hmac(env.LINK_SECRET, `unsub:${m[1]}.${m[2]}`));
  if (!timingSafeEqual(expected, m[3])) return null;
  return { memberId: Number(m[1]), kind: m[2] as EmailKind };
}
