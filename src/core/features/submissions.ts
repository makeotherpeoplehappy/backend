// Suggestions and stories: minimal versions for Phase 1, so the foundation
// checks (daily limits, one record per click, queueing while Webflow is
// down, account deletion) run against real records. Phase 2 adds review,
// photos, videos, the "with" line and the rest.

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import type { Member } from '../identity';
import { enqueue } from '../queue';
import { consumeDaily, refundDaily } from '../safety';
import { getAction } from './actions';

const MAX_SUGGESTION = 2000;
const MAX_STORY = 5000;

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

function titleFrom(text: string): string {
  const first = text.split('\n')[0];
  return first.length > 80 ? `${first.slice(0, 77)}...` : first;
}

export const suggestionSlug = (id: number) => `suggestion-${id}`;
export const storySlug = (id: number) => `story-${id}`;
export const storyCreateKey = (id: number) => `story-create:${id}`;

export async function sendSuggestion(env: Env, deps: Deps, member: Member, body: { text?: unknown }) {
  const text = cleanText(body.text, MAX_SUGGESTION);
  if (text.length < 3) throw new HttpError(400, 'empty_suggestion', 'Please write your idea before sending it.');
  await consumeDaily(env, deps, member.id, 'suggestion');
  let id: number | null = null;
  try {
    const now = iso(deps.now());
    const row = await env.DB.prepare(
      `INSERT INTO suggestions (member_id, text, status, created_at, updated_at) VALUES (?1, ?2, 'new', ?3, ?3) RETURNING id`,
    )
      .bind(member.id, text, now)
      .first<{ id: number }>();
    id = row!.id;
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
        },
        saveIdTo: { table: 'suggestions', id },
      },
      member.id,
    ).run();
    return { id, status: 'new' };
  } catch (e) {
    // The record and its queued write are kept together: neither or both.
    if (id !== null) await env.DB.prepare(`DELETE FROM suggestions WHERE id = ?1`).bind(id).run();
    await refundDaily(env, deps, member.id, 'suggestion');
    throw e;
  }
}

export async function sendStory(env: Env, deps: Deps, member: Member, body: { actionId?: unknown; text?: unknown; showName?: unknown }) {
  const actionId = typeof body.actionId === 'string' ? body.actionId : '';
  const action = actionId ? await getAction(env, deps, actionId) : null;
  if (!action) throw new HttpError(404, 'action_not_found', 'This action is no longer available.');
  const text = cleanText(body.text, MAX_STORY);
  if (!text) throw new HttpError(400, 'empty_story', 'Please add some text before sending your story.');
  const done = await env.DB.prepare(`SELECT 1 AS ok FROM done_marks WHERE member_id = ?1 AND action_id = ?2 LIMIT 1`).bind(member.id, actionId).first();
  if (!done) throw new HttpError(403, 'not_done', 'You can share a story once you have marked this action as done.');
  const existing = await env.DB.prepare(`SELECT id FROM stories WHERE member_id = ?1 AND action_id = ?2`).bind(member.id, actionId).first();
  if (existing) throw new HttpError(409, 'story_exists', 'You have already shared a story for this action.');
  const showName = body.showName !== false;

  await consumeDaily(env, deps, member.id, 'story');
  let id: number | null = null;
  try {
    const now = iso(deps.now());
    const row = await env.DB.prepare(
      `INSERT INTO stories (member_id, action_id, text, show_name, status, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'new', ?5, ?5) RETURNING id`,
    )
      .bind(member.id, actionId, text, showName ? 1 : 0, now)
      .first<{ id: number }>();
    id = row!.id;
    await enqueue(
      env,
      deps,
      storyCreateKey(id),
      {
        op: 'webflow.create',
        collectionId: CMS.stories.id,
        isDraft: true,
        fieldData: {
          name: `${showName && member.first_name ? member.first_name : 'A member'}: ${action.title}`.slice(0, 256),
          slug: storySlug(id),
          story: text,
          action: actionId,
          'submitted-by': showName ? member.first_name || '' : '',
          email: member.email || '',
          'submitted-on': now,
          status: CMS.stories.status.new,
        },
        saveIdTo: { table: 'stories', id },
      },
      member.id,
    ).run();
    return { id, status: 'new' };
  } catch (e) {
    if (id !== null) await env.DB.prepare(`DELETE FROM stories WHERE id = ?1`).bind(id).run();
    await refundDaily(env, deps, member.id, 'story');
    if (String((e as Error).message).includes('UNIQUE')) throw new HttpError(409, 'story_exists', 'You have already shared a story for this action.');
    throw e;
  }
}

interface StoryRow {
  id: number;
  member_id: number;
  cms_item_id: string | null;
  photo_key: string | null;
}

/** Statements that take a story off the site and out of the database. */
export function storyRemovalStatements(env: Env, deps: Deps, story: StoryRow): D1PreparedStatement[] {
  return [
    // If the CMS item was never created, its queued create is cancelled.
    env.DB.prepare(`UPDATE outbox SET status = 'cancelled', updated_at = ?2 WHERE dedupe_key = ?1 AND status = 'pending'`).bind(
      storyCreateKey(story.id),
      iso(deps.now()),
    ),
    enqueue(env, deps, `story-delete:${story.id}`, {
      op: 'webflow.delete',
      collectionId: CMS.stories.id,
      itemId: story.cms_item_id || undefined,
      slug: storySlug(story.id),
      afterCreate: storyCreateKey(story.id),
    }),
    env.DB.prepare(`DELETE FROM story_with WHERE story_id = ?1`).bind(story.id),
    env.DB.prepare(`DELETE FROM stories WHERE id = ?1`).bind(story.id),
  ];
}

export async function deleteStory(env: Env, deps: Deps, member: Member, storyId: number) {
  const story = await env.DB.prepare(`SELECT id, member_id, cms_item_id, photo_key FROM stories WHERE id = ?1`).bind(storyId).first<StoryRow>();
  if (!story || story.member_id !== member.id) throw new HttpError(404, 'story_not_found', 'That story could not be found.');
  await env.DB.batch(storyRemovalStatements(env, deps, story));
  if (story.photo_key) await env.MEDIA.delete(story.photo_key);
  return { deleted: true };
}
