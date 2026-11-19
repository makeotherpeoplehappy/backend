// Suggestions (Phase 2): saved here and sent to the Suggestions collection
// for review, with close matches noted for Mickey. Stories live in stories.ts.

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import type { Member } from '../identity';
import { enqueue } from '../queue';
import { consumeDaily, refundDaily } from '../safety';
import { placeBySlug } from './places';

const MAX_SUGGESTION = 2000;

export function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

function titleFrom(text: string): string {
  const first = text.split('\n')[0];
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

export const suggestionSlug = (id: number) => `suggestion-${id}`;
export { storySlug, storyCreateKey } from './stories';

export async function sendSuggestion(env: Env, deps: Deps, member: Member, body: { text?: unknown; location?: unknown }) {
  const text = cleanText(body.text, MAX_SUGGESTION);
  if (text.length < 3) throw new HttpError(400, 'empty_suggestion', 'err-empty-suggestion');
  // Where it works best (optional): one of the site's places, or anywhere.
  const slug = typeof body.location === 'string' ? body.location.trim() : '';
  const place = slug ? await placeBySlug(env, deps, slug) : null;
  if (slug && !place) throw new HttpError(400, 'invalid_location', 'err-invalid-location');
  const id = await createSuggestion(env, deps, member, { text, place });
  return { id, status: 'new' };
}

/**
 * Saves a suggestion and queues it for the Suggestions collection (as "New").
 * kind 'own' is something the member already did (see own.ts): the review
 * notes say so, with who it was for.
 */
export async function createSuggestion(
  env: Env,
  deps: Deps,
  member: Member,
  opts: { text: string; place?: { slug: string; id: string } | null; kind?: 'idea' | 'own'; who?: string | null; note?: string },
): Promise<number> {
  const { text, place = null, kind = 'idea', who = null, note = '' } = opts;
  await consumeDaily(env, deps, member.id, 'suggestion');
  let id: number | null = null;
  try {
    const now = iso(deps.now());
    const row = await env.DB.prepare(
      `INSERT INTO suggestions (member_id, text, location, status, created_at, updated_at, kind, who) VALUES (?1, ?2, ?4, 'new', ?3, ?3, ?5, ?6) RETURNING id`,
    )
      .bind(member.id, text, now, place?.slug ?? null, kind, who)
      .first<{ id: number }>();
    id = row!.id;
    const similar = await similarNotes(env, text, id);
    if (similar) await env.DB.prepare(`UPDATE suggestions SET similar_notes = ?2 WHERE id = ?1`).bind(id, similar).run();
    const notes = [note, similar].filter(Boolean).join(' | ').slice(0, 2000);
    await enqueue(
      env,
      deps,
      `suggestion-create:${id}`,
      {
        op: 'webflow.create',
        collectionId: CMS.suggestions.id,
        isDraft: true,
        fieldData: {
          name: titleFrom(text),
          slug: suggestionSlug(id),
          idea: text,
          'submitted-by': member.first_name || '',
          email: member.email || '',
          'submitted-on': now,
          status: CMS.suggestions.status.new,
          'review-notes': notes,
          ...(place ? { location: place.id } : {}),
        },
        saveIdTo: { table: 'suggestions', id },
      },
      member.id,
    ).run();
    return id;
  } catch (e) {
    // The record and its queued write are kept together: neither or both.
    if (id !== null) await env.DB.prepare(`DELETE FROM suggestions WHERE id = ?1`).bind(id).run();
    await refundDaily(env, deps, member.id, 'suggestion');
    throw e;
  }
}

export { deleteStory, storyRemovalStatements } from './stories';

function words(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9æøåäöüé\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP.has(w)),
  );
}
const STOP = new Set(['the', 'and', 'for', 'you', 'your', 'with', 'who', 'that', 'this', 'them', 'they', 'their', 'from', 'about', 'someone', 'something']);

export function similarity(a: string, b: string): number {
  const x = words(a);
  const y = words(b);
  if (!x.size || !y.size) return 0;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / Math.min(x.size, y.size);
}

/** Close matches among existing actions and earlier suggestions, for the review notes. */
export async function similarNotes(env: Env, text: string, selfId: number | null): Promise<string> {
  const actions = await env.DB.prepare(`SELECT title FROM actions WHERE status = 'published'`).all<{ title: string }>();
  const earlier = await env.DB.prepare(`SELECT id, text FROM suggestions WHERE id != ?1 ORDER BY id DESC LIMIT 500`).bind(selfId ?? -1).all<{ id: number; text: string }>();
  const hits: { score: number; note: string }[] = [];
  for (const a of actions.results) {
    const sc = similarity(text, a.title);
    if (sc >= 0.6) hits.push({ score: sc, note: `Action: ${a.title}` });
  }
  for (const e of earlier.results) {
    const sc = similarity(text, e.text);
    if (sc >= 0.6) hits.push({ score: sc, note: `Suggestion ${e.id}: ${titleFrom(e.text)}` });
  }
  hits.sort((p, q) => q.score - p.score);
  return hits.length ? `Similar to: ${hits.slice(0, 3).map((h) => h.note).join(' | ')}`.slice(0, 2000) : '';
}

export { titleFrom };
