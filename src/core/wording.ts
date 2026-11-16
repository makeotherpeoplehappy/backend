// Wording kept in Webflow. The site's footer has a hidden "Site wording"
// block: one element per text, marked data-hf-copy="key" (the page scripts
// read the same block). The backend reads the published home page for it, so
// error messages, emails and the drop details line are edited in Webflow too.
// Cached for 10 minutes; the last good copy is kept for when the site cannot
// be reached.

import type { Deps, Env } from './env';

export type Wording = Record<string, string>;

const FRESH = 'site-wording';
const LAST = 'site-wording:last';
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) =>
      e[0] === '#' ? String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENTITIES[e.toLowerCase()] ?? m,
    )
    .trim();
}

/** The wording block's texts, by key, from a page's HTML. */
export function parseWording(html: string): Wording {
  const out: Wording = {};
  const re = /<([a-z0-9]+)\b[^>]*\bdata-hf-copy="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/gi;
  for (let m = re.exec(html); m; m = re.exec(html)) if (!(m[2] in out)) out[m[2]] = decode(m[3]);
  return out;
}

/** The site's wording: cached, else read from the published site, else the last good copy. */
export async function siteWording(env: Env, deps: Deps): Promise<Wording> {
  const fresh = (await env.CACHE.get(FRESH, 'json').catch(() => null)) as Wording | null;
  if (fresh) return fresh;
  if (deps.site) {
    try {
      const res = await deps.fetch(`${deps.site}/`, { headers: { Accept: 'text/html' } });
      if (res.ok) {
        const w = parseWording(await res.text());
        if (Object.keys(w).length) {
          await env.CACHE.put(FRESH, JSON.stringify(w), { expirationTtl: 600 });
          await env.CACHE.put(LAST, JSON.stringify(w));
          return w;
        }
      }
    } catch {
      // fall through to the last good copy
    }
  }
  return ((await env.CACHE.get(LAST, 'json').catch(() => null)) as Wording | null) || {};
}

/** One text, with {name}-style parts filled in. Empty when the key is missing. */
export function word(w: Wording, key: string, vars: Record<string, string | number | null | undefined> = {}): string {
  let t = w[key] ?? '';
  for (const [k, v] of Object.entries(vars)) t = t.split(`{${k}}`).join(v === null || v === undefined ? '' : String(v));
  return t;
}
