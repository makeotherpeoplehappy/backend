// Wording lives in Webflow (the footer's "Site wording" block, and elements on
// the pages). This fails when a visible sentence is written into the code
// again. Staff-only parts (/lab, admin emails) and a few technical answers
// are allowed.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STAFF_FILES = ['public/lab.js', 'src/core/features/ops.ts', 'src/core/errors.ts'];
const TECHNICAL = new Set([
  'Not authorised.',
  'Invalid body.',
  'Not allowed.',
  'Not found.',
  'No Shopify customer with that ID.',
  'That decision could not be read.',
  'Someone has already reviewed this.',
]);

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(join(ROOT, rel)).isDirectory() ? files(rel) : [rel];
  });
}

describe('No wording in code', () => {
  it('scripts and backend have no visible sentences outside Webflow', () => {
    const list = [...files('public'), ...files('site'), ...files('src')].filter((f) => /\.(js|ts)$/.test(f) && !STAFF_FILES.includes(f));
    const found: string[] = [];
    for (const f of list) {
      const src = readFileSync(join(ROOT, f), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:'"])\/\/.*$/gm, '$1');
      for (const m of src.matchAll(/(['"`])([A-Z][a-z']+(?: [A-Za-z',]+){2,}[.!?]?)\1/g)) {
        const text = m[2];
        if (TECHNICAL.has(text) || /\$\{/.test(text)) continue;
        found.push(`${f}: ${text}`);
      }
    }
    expect(found).toEqual([]);
  });
});
