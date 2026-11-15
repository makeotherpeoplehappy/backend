import { EMAIL_KINDS, type EmailKind } from './config';
import type { Deps, Env } from './env';
import { UpstreamError, base64url, callUpstream, hmac, retryAfterSeconds, timingSafeEqual } from './http';
import type { Member } from './identity';

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

const SIGN_OFF = '\n\nWith thanks,\nHappiness Foundation';

function render(kind: EmailKind, member: Member, v: MemberEmailVars): { subject: string; body: string } {
  const hi = member.first_name ? `Hi ${member.first_name},` : 'Hi,';
  const link = v.actionUrl ? `\n\n${v.actionUrl}` : '';
  switch (kind) {
    case 'invite_summary': {
      const names = v.joinedNames || [];
      const who = names.length <= 1 ? names[0] || 'Someone' : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
      const verb = names.length > 1 ? 'are' : 'is';
      return {
        subject: names.length > 1 ? `${names.length} people joined your invite` : `${who} joined your invite`,
        body: `${hi}\n\n${who} ${verb} in${v.actionTitle ? ` for "${v.actionTitle}"` : ''}.${link}`,
      };
    }
    case 'story_approved':
      return {
        subject: 'Your story is on the site',
        body: `${hi}\n\nYour story${v.actionTitle ? ` about "${v.actionTitle}"` : ''} has been approved and is now on the site.${link}`,
      };
    case 'suggestion_live':
      return {
        subject: 'Your suggested action is live',
        body: `${hi}\n\nThe action you suggested${v.actionTitle ? `, "${v.actionTitle}",` : ''} is now live for everyone to do.${link}`,
      };
    case 'pledge_reminder':
      return {
        subject: 'Your pledge is still open',
        body: `${hi}\n\nA week ago you made a pledge with your order. Mark an action as done to keep it.${link}`,
      };
  }
}

export function wantsEmail(member: Member, kind: EmailKind): boolean {
  return Number(member[EMAIL_KINDS[kind]]) === 1 && !!member.email;
}

/** Builds a member email with a one-click unsubscribe link, or null if the member turned it off. */
export async function memberEmail(env: Env, member: Member, kind: EmailKind, vars: MemberEmailVars, baseUrl: string): Promise<EmailMessage | null> {
  if (!wantsEmail(member, kind)) return null;
  const { subject, body } = render(kind, member, vars);
  const offUrl = `${baseUrl}/api/notifications/off?t=${await signUnsubscribe(env, member.id, kind)}`;
  return {
    to: member.email!,
    subject,
    text: `${body}${SIGN_OFF}\n\nTo stop these emails: ${offUrl}`,
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
