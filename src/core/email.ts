import { EMAIL_KINDS, type EmailKind } from './config';
import type { Deps, Env } from './env';
import { UpstreamError, base64url, callUpstream, hmac, retryAfterSeconds, timingSafeEqual } from './http';
import type { Member } from './identity';
import { siteWording, word, type Wording } from './wording';

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
  headers?: Record<string, string>;
}

/** Sends one email through Resend. Plain text only, so it reads well anywhere. */
export async function sendEmail(env: Env, deps: Deps, msg: EmailMessage, idempotencyKey?: string): Promise<void> {
  const res = await callUpstream(deps.fetch, 'email', 'https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey.slice(0, 256) } : {}),
    },
    body: JSON.stringify({ from: env.EMAIL_FROM, to: [msg.to], subject: msg.subject, text: msg.text, headers: msg.headers }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new UpstreamError('email', res.status, `Resend failed (${res.status}): ${text.slice(0, 300)}`, retryAfterSeconds(res));
  }
}

// ---------------------------------------------------------------------------
// The four member emails. Later phases call memberEmail() and queue the
// result; Phase 1 provides the templates, the on/off settings and the links.
// ---------------------------------------------------------------------------

export interface MemberEmailVars {
  /** invite_summary: first names of the people who joined today. */
  joinedNames?: string[];
  actionTitle?: string;
  actionUrl?: string;
}

// Every word of these emails is in the site's wording block in Webflow
// ("email-..." keys); {name}-style parts are filled in here.
function render(kind: EmailKind, member: Member, v: MemberEmailVars, w: Wording): { subject: string; body: string } {
  const hi = member.first_name ? word(w, 'email-hi', { name: member.first_name }) : word(w, 'email-hi-anon');
  const link = v.actionUrl ? `\n\n${v.actionUrl}` : '';
  const action = v.actionTitle;
  const pick = (key: string) => word(w, action ? key : `${key}-untitled`, { action });
  switch (kind) {
    case 'invite_summary': {
      const names = v.joinedNames || [];
      const one = names.length <= 1;
      const who = one ? names[0] || word(w, 'email-someone') : `${names.slice(0, -1).join(', ')} ${word(w, 'email-and')} ${names[names.length - 1]}`;
      return {
        subject: one ? word(w, 'email-invite-subject-one', { name: who }) : word(w, 'email-invite-subject-many', { n: names.length }),
        body: `${hi}\n\n${word(w, `email-invite-body-${one ? 'one' : 'many'}${action ? '' : '-untitled'}`, { name: who, names: who, action })}${link}`,
      };
    }
    case 'story_approved':
      return { subject: word(w, 'email-story-subject'), body: `${hi}\n\n${pick('email-story-body')}${link}` };
    case 'suggestion_live':
      return { subject: word(w, 'email-suggestion-subject'), body: `${hi}\n\n${pick('email-suggestion-body')}${link}` };
    case 'pledge_reminder':
      return { subject: word(w, 'email-pledge-subject'), body: `${hi}\n\n${word(w, 'email-pledge-body')}${link}` };
  }
}

export function wantsEmail(member: Member, kind: EmailKind): boolean {
  return Number(member[EMAIL_KINDS[kind]]) === 1 && !!member.email;
}

/** Builds a member email with a one-click unsubscribe link, or null if the member turned it off. */
export async function memberEmail(env: Env, deps: Deps, member: Member, kind: EmailKind, vars: MemberEmailVars, baseUrl: string): Promise<EmailMessage | null> {
  if (!wantsEmail(member, kind)) return null;
  const w = await siteWording(env, deps);
  const { subject, body } = render(kind, member, vars, w);
  const offUrl = `${baseUrl}/api/notifications/off?t=${await signUnsubscribe(env, member.id, kind)}`;
  return {
    to: member.email!,
    subject,
    text: `${body}\n\n${word(w, 'email-signoff')}\n${word(w, 'email-signoff-name')}\n\n${word(w, 'email-unsubscribe', { url: offUrl })}`,
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
