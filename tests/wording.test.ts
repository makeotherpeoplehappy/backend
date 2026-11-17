// Guards for src/wording/en.json, the one home of interface text:
// every key the code asks for exists, every key in the file is used, and
// each call fills in exactly the {parts} its text has.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { WORDING } from './wording';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CALLS = ['copyText', 'copy', 'copyNodes', 'word'];

function files(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((f) => {
    const rel = `${dir}/${f}`;
    return statSync(join(ROOT, rel)).isDirectory() ? files(rel) : /\.(js|ts)$/.test(f) ? [rel] : [];
  });
}
const SOURCES = [...files('public'), ...files('src')].map((f) => ({ f, src: readFileSync(join(ROOT, f), 'utf8') }));

/** The text between a call's parentheses, from just after "(". */
function argsAt(src: string, i: number): string {
  let depth = 1;
  let quote = '';
  for (let j = i; j < src.length; j++) {
    const ch = src[j];
    if (quote) {
      if (ch === '\\') j++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if (ch === '(' || ch === '{' || ch === '[') depth++;
    else if (ch === ')' || ch === '}' || ch === ']') if (--depth === 0) return src.slice(i, j);
  }
  return '';
}

/** Splits at commas that are not inside brackets or strings. */
function topLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let start = 0;
  for (let j = 0; j < s.length; j++) {
    const ch = s[j];
    if (quote) {
      if (ch === '\\') j++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') quote = ch;
    else if ('({['.includes(ch)) depth++;
    else if (')}]'.includes(ch)) depth--;
    else if (ch === sep && depth === 0) {
      out.push(s.slice(start, j));
      start = j + 1;
    }
  }
  out.push(s.slice(start));
  return out.map((x) => x.trim()).filter(Boolean);
}

interface Call {
  where: string;
  keys: string[];
  vars: string[] | null;
}

function calls(): Call[] {
  const out: Call[] = [];
  for (const { f, src } of SOURCES) {
    const re = new RegExp(`\\b(${CALLS.join('|')})\\(`, 'g');
    for (let m = re.exec(src); m; m = re.exec(src)) {
      const before = src.slice(Math.max(0, m.index - 9), m.index);
      if (/function\s*$/.test(before)) continue; // the definitions themselves
      const args = topLevel(argsAt(src, m.index + m[0].length), ',');
      if (!args.length) continue;
      // String literals that are results, not values being compared (kind === 'with_me' ? ...).
      const keys = [...args[0].matchAll(/'([a-z0-9_-]+)'/g)].filter((k) => !/[!=]==\s*$/.test(args[0].slice(0, k.index))).map((k) => k[1]);
      if (!keys.length) continue;
      let vars: string[] | null = null;
      if (args[1] && args[1].startsWith('{')) vars = topLevel(args[1].slice(1, -1), ',').map((p) => p.split(':')[0].trim());
      const line = src.slice(0, m.index).split('\n').length;
      out.push({ where: `${f}:${line}`, keys: args[0].includes("+ k") || /'-$/.test(keys[keys.length - 1]) ? [] : keys, vars });
    }
  }
  return out;
}

const parts = (text: string) => [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort();

describe('Interface text (src/wording/en.json)', () => {
  it('has every key the code asks for', () => {
    const missing = calls().flatMap((c) => c.keys.filter((k) => !(k in WORDING)).map((k) => `${c.where}: ${k}`));
    expect(missing).toEqual([]);
  });

  it('fills in exactly the {parts} each text has', () => {
    const wrong: string[] = [];
    for (const c of calls()) {
      if (c.vars === null) continue; // no parts given: checked below
      for (const k of c.keys) {
        if (!(k in WORDING)) continue;
        const want = parts(WORDING[k]);
        const got = [...new Set(c.vars)].sort();
        if (want.join() !== got.join()) wrong.push(`${c.where}: ${k} has {${want.join('}, {')}} but the call gives ${got.join(', ') || 'none'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('only texts without {parts} are used without filling any in', () => {
    const wrong = calls()
      .filter((c) => c.vars === null && !/copyNodes/.test(c.where))
      .flatMap((c) => c.keys.filter((k) => k in WORDING && parts(WORDING[k]).length).map((k) => `${c.where}: ${k}`));
    // Texts with parts that are filled in another way (keys picked at run time, error keys).
    expect(wrong).toEqual([]);
  });

  it('has no texts that nothing uses', () => {
    const all = SOURCES.map((s) => s.src).join('\n');
    const prefixes = [...all.matchAll(/'([a-z]+(?:-[a-z]+)*-)' \+/g)].map((m) => m[1]);
    const unused = Object.keys(WORDING).filter((k) => !all.includes(`'${k}'`) && !prefixes.some((p) => k.startsWith(p)));
    expect(unused).toEqual([]);
  });
});
