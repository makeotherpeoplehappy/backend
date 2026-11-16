// One-time setup: creates (or updates) the member email templates in Resend
// from the email wording that was kept in Webflow, and publishes them. After
// this, the emails are edited in Resend only. Run from /lab by an owner.

import type { Deps, Env } from '../env';
import { siteWording, type Wording } from '../wording';

interface Spec {
  alias: string;
  name: string;
  subject: string;
  body: string;
  /** Webflow {part} -> Resend VARIABLE, for the subject and body. */
  vars: Record<string, string>;
}

export const MEMBER_TEMPLATES: Spec[] = [
  { alias: 'hf-invite-joined-one', name: 'Invite: one person joined', subject: 'email-invite-subject-one', body: 'email-invite-body-one', vars: { name: 'NAME', action: 'ACTION_TITLE' } },
  { alias: 'hf-invite-joined-one-untitled', name: 'Invite: one person joined (no action title)', subject: 'email-invite-subject-one', body: 'email-invite-body-one-untitled', vars: { name: 'NAME' } },
  { alias: 'hf-invite-joined-many', name: 'Invite: several people joined', subject: 'email-invite-subject-many', body: 'email-invite-body-many', vars: { names: 'NAMES', n: 'COUNT', action: 'ACTION_TITLE' } },
  { alias: 'hf-invite-joined-many-untitled', name: 'Invite: several people joined (no action title)', subject: 'email-invite-subject-many', body: 'email-invite-body-many-untitled', vars: { names: 'NAMES', n: 'COUNT' } },
  { alias: 'hf-story-live', name: 'Story is on the site', subject: 'email-story-subject', body: 'email-story-body', vars: { action: 'ACTION_TITLE' } },
  { alias: 'hf-story-live-untitled', name: 'Story is on the site (no action title)', subject: 'email-story-subject', body: 'email-story-body-untitled', vars: {} },
  { alias: 'hf-suggestion-live', name: 'Suggested action is live', subject: 'email-suggestion-subject', body: 'email-suggestion-body', vars: { action: 'ACTION_TITLE' } },
  { alias: 'hf-suggestion-live-untitled', name: 'Suggested action is live (no action title)', subject: 'email-suggestion-subject', body: 'email-suggestion-body-untitled', vars: {} },
  { alias: 'hf-pledge-reminder', name: 'Pledge is still open', subject: 'email-pledge-subject', body: 'email-pledge-body', vars: {} },
];

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const variable = (v: string) => `{{{${v}}}}`;

/** Webflow wording with {part}s turned into Resend variables (HTML-escaped around them). */
function convert(text: string, vars: Record<string, string>, html: boolean): string {
  return text
    .split(/(\{\w+\})/)
    .map((bit) => {
      const m = /^\{(\w+)\}$/.exec(bit);
      if (m && vars[m[1]]) return variable(vars[m[1]]);
      return html ? esc(bit) : bit;
    })
    .join('');
}

export function templateFor(spec: Spec, w: Wording, from: string) {
  const need = (k: string) => {
    if (!w[k]) throw new Error(`Missing wording "${k}" in Webflow`);
    return w[k];
  };
  const p = 'margin:0 0 16px';
  const html =
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>` +
    `<body style="margin:0;padding:0;background:#ffffff">` +
    `<div style="max-width:560px;margin:0 auto;padding:32px 24px;font-family:Outfit,Arial,Helvetica,sans-serif;font-size:16px;line-height:1.5;color:#222222">` +
    `<p style="${p}">${convert(need('email-hi'), { name: 'GREETING_NAME' }, true)}</p>` +
    `<p style="${p}">${convert(need(spec.body), spec.vars, true)}</p>` +
    `<p style="${p}"><a href="${variable('LINK_URL')}" style="color:#4D7FB3">${variable('LINK_URL')}</a></p>` +
    `<p style="${p}">${esc(need('email-signoff'))}<br>${esc(need('email-signoff-name'))}</p>` +
    `<p style="margin:32px 0 0;font-size:13px;line-height:1.4;color:#777777">${convert(need('email-unsubscribe'), { url: 'UNSUB_LINK' }, true).replace(variable('UNSUB_LINK'), `<a href="${variable('UNSUB_URL')}" style="color:#777777">${variable('UNSUB_URL')}</a>`)}</p>` +
    `</div></body></html>`;
  const keys = [...new Set(['GREETING_NAME', 'LINK_URL', 'UNSUB_URL', ...Object.values(spec.vars)])];
  return {
    name: spec.name,
    alias: spec.alias,
    from,
    subject: convert(need(spec.subject), spec.vars, false),
    html,
    variables: keys.map((key) => (key === 'GREETING_NAME' ? { key, type: 'string', fallback_value: 'there' } : { key, type: 'string' })),
  };
}

/** Creates or updates each member email template in Resend and publishes it. */
export async function setUpEmailTemplates(env: Env, deps: Deps) {
  const w = await siteWording(env, deps);
  const api = 'https://api.resend.com/templates';
  // Templates need a full-access key; the site's own key only sends. A temporary
  // RESEND_SETUP_KEY is used when set, so the sending key stays sending-only.
  const headers = { Authorization: `Bearer ${env.RESEND_SETUP_KEY || env.RESEND_API_KEY}`, 'Content-Type': 'application/json' };
  const done: { alias: string; action: 'created' | 'updated' }[] = [];
  const failed: { alias: string; status: number; message: string }[] = [];
  for (const spec of MEMBER_TEMPLATES) {
    try {
      const body = JSON.stringify(templateFor(spec, w, env.EMAIL_FROM));
      const existing = await deps.fetch(`${api}/${spec.alias}`, { headers });
      const write = existing.ok
        ? await deps.fetch(`${api}/${spec.alias}`, { method: 'PATCH', headers, body })
        : await deps.fetch(api, { method: 'POST', headers, body });
      if (!write.ok) {
        failed.push({ alias: spec.alias, status: write.status, message: (await write.text().catch(() => '')).slice(0, 300) });
        continue;
      }
      const pub = await deps.fetch(`${api}/${spec.alias}/publish`, { method: 'POST', headers });
      if (!pub.ok) {
        failed.push({ alias: spec.alias, status: pub.status, message: (await pub.text().catch(() => '')).slice(0, 300) });
        continue;
      }
      done.push({ alias: spec.alias, action: existing.ok ? 'updated' : 'created' });
    } catch (e) {
      failed.push({ alias: spec.alias, status: 0, message: (e as Error).message });
    }
  }
  return { done, failed };
}
