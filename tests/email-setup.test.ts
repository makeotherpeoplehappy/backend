// The one-time email template setup: built from the Webflow wording, created
// and published in Resend under stable aliases.

import { describe, expect, it } from 'vitest';
import { MEMBER_TEMPLATES, setUpEmailTemplates, templateFor } from '../src/core/features/email-setup';
import { WORDING } from './wording';

describe('Email template setup', () => {
  it('builds each template from the Webflow wording with Resend variables', () => {
    const t = templateFor(MEMBER_TEMPLATES.find((s) => s.alias === 'hf-invite-joined-many')!, WORDING, 'HF <hello@example.com>');
    expect(t.subject).toBe('{{{COUNT}}} people joined your invite');
    expect(t.html).toContain('{{{NAMES}}} are in for &quot;{{{ACTION_TITLE}}}&quot;.');
    expect(t.html).toContain('Hi {{{GREETING_NAME}}},');
    expect(t.html).toContain('href="{{{UNSUB_URL}}}"');
    expect(t.variables.map((v) => v.key).sort()).toEqual(['ACTION_TITLE', 'COUNT', 'GREETING_NAME', 'LINK_URL', 'NAMES', 'UNSUB_URL']);
    expect(t.variables.find((v) => v.key === 'GREETING_NAME')).toMatchObject({ fallback_value: 'there' });
    for (const s of MEMBER_TEMPLATES) expect(() => templateFor(s, WORDING, 'x')).not.toThrow();
  });

  it('creates new templates, updates existing ones, and publishes each', async () => {
    const calls: string[] = [];
    const fetch = (async (url: string, init: RequestInit = {}) => {
      const m = init.method || 'GET';
      calls.push(`${m} ${url.replace('https://api.resend.com', '')}`);
      if (m === 'GET') return new Response('', { status: url.endsWith('hf-pledge-reminder') ? 200 : 404 });
      return new Response('{"object":"template","id":"t"}', { status: 200 });
    }) as typeof globalThis.fetch;
    const store = new Map<string, string>([['site-wording', JSON.stringify(WORDING)]]);
    const env = { RESEND_API_KEY: 're_test', EMAIL_FROM: 'HF <hello@example.com>', CACHE: { get: async (k: string) => (store.has(k) ? JSON.parse(store.get(k)!) : null), put: async () => undefined } };
    const out = await setUpEmailTemplates(env as never, { fetch, now: () => new Date() });
    expect(out.failed).toEqual([]);
    expect(out.done).toHaveLength(MEMBER_TEMPLATES.length);
    expect(out.done.find((d) => d.alias === 'hf-pledge-reminder')!.action).toBe('updated');
    expect(calls).toContain('POST /templates');
    expect(calls).toContain('PATCH /templates/hf-pledge-reminder');
    expect(calls.filter((c) => c.endsWith('/publish'))).toHaveLength(MEMBER_TEMPLATES.length);
  });
});
