// Interface text (buttons, labels, messages) lives in one file:
// src/wording/en.json. Page content is in Webflow, product copy in Shopify
// and member emails in Resend; see README "Where text lives".
//
// The backend imports the file; the page scripts get it from
// /join/hf-wording.js. Tests check that every key the code uses exists and
// that its {parts} match.

import en from '../wording/en.json';

export type Wording = Record<string, string>;

export const WORDING: Wording = en;

/** One text, with {name}-style parts filled in. Empty when the key is missing. */
export function word(key: string, vars: Record<string, string | number | null | undefined> = {}): string {
  let t = WORDING[key] ?? '';
  for (const [k, v] of Object.entries(vars)) t = t.split(`{${k}}`).join(v === null || v === undefined ? '' : String(v));
  return t;
}

/** The page scripts' copy of the wording, as a small script. */
export const WORDING_SCRIPT = `window.HFW=${JSON.stringify(WORDING).replace(/</g, '\\u003c')};`;
