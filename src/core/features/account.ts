import { CMS, EMAIL_KINDS, type EmailKind } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import type { Member } from '../identity';
import { enqueue } from '../queue';
import { memberTally } from './actions';
import { storyRemovalStatements, suggestionSlug } from './submissions';

export async function getAccount(env: Env, member: Member) {
  const done = await env.DB.prepare(
    `SELECT d.action_id AS actionId, d.action_title AS title, d.done_at AS doneAt, a.slug AS slug, a.status AS actionStatus
     FROM done_marks d LEFT JOIN actions a ON a.cms_item_id = d.action_id
     WHERE d.member_id = ?1 ORDER BY d.done_at DESC LIMIT 500`,
  )
    .bind(member.id)
    .all();
  const stories = await env.DB.prepare(`SELECT id, action_id AS actionId, status, created_at AS createdAt FROM stories WHERE member_id = ?1 ORDER BY created_at DESC`)
    .bind(member.id)
    .all();
  const suggestions = await env.DB.prepare(`SELECT id, text, status, created_at AS createdAt FROM suggestions WHERE member_id = ?1 ORDER BY created_at DESC`)
    .bind(member.id)
    .all();
  return {
    firstName: member.first_name,
    tally: await memberTally(env, member.id),
    done: done.results,
    stories: stories.results,
    suggestions: suggestions.results,
    settings: settingsOf(member),
  };
}

export function settingsOf(member: Member): Record<EmailKind, boolean> {
  const out = {} as Record<EmailKind, boolean>;
  for (const [kind, column] of Object.entries(EMAIL_KINDS) as [EmailKind, keyof Member][]) out[kind] = Number(member[column]) === 1;
  return out;
}

export async function updateSettings(env: Env, deps: Deps, member: Member, body: { notifications?: Record<string, unknown> }) {
  const changes = body.notifications || {};
  const sets: string[] = [];
  const values: unknown[] = [];
  for (const [kind, value] of Object.entries(changes)) {
    if (!(kind in EMAIL_KINDS) || typeof value !== 'boolean') {
      throw new HttpError(400, 'invalid_setting', 'That setting could not be saved.');
    }
    values.push(value ? 1 : 0);
    sets.push(`${EMAIL_KINDS[kind as EmailKind]} = ?${values.length}`);
  }
  if (!sets.length) return { settings: settingsOf(member) };
  values.push(iso(deps.now()), member.id);
  const row = await env.DB.prepare(`UPDATE members SET ${sets.join(', ')}, updated_at = ?${values.length - 1} WHERE id = ?${values.length} RETURNING *`)
    .bind(...values)
    .first<Member>();
  return { settings: settingsOf(row!) };
}

/**
 * Removes a member's stories and name from the site and the database.
 * Done marks and likes stay, so every count is unchanged, but they now belong
 * to a nameless record that cannot be traced back to the person.
 */
export async function deleteMemberData(env: Env, deps: Deps, memberId: number): Promise<{ storiesRemoved: number }> {
  const now = iso(deps.now());
  const stories = await env.DB.prepare(`SELECT id, member_id, cms_item_id, photo_key FROM stories WHERE member_id = ?1`)
    .bind(memberId)
    .all<{ id: number; member_id: number; cms_item_id: string | null; photo_key: string | null }>();
  const suggestions = await env.DB.prepare(`SELECT id, cms_item_id FROM suggestions WHERE member_id = ?1`)
    .bind(memberId)
    .all<{ id: number; cms_item_id: string | null }>();

  const stmts: D1PreparedStatement[] = [];
  for (const s of stories.results) stmts.push(...storyRemovalStatements(env, deps, s));
  for (const s of suggestions.results) {
    // The idea stays for review, without who sent it.
    stmts.push(
      env.DB.prepare(`UPDATE outbox SET payload = json_set(payload, '$.fieldData."submitted-by"', '', '$.fieldData.email', '') WHERE dedupe_key = ?1 AND status = 'pending'`).bind(
        `suggestion-create:${s.id}`,
      ),
      enqueue(env, deps, `suggestion-anonymise:${s.id}`, {
        op: 'webflow.update',
        collectionId: CMS.suggestions.id,
        itemId: s.cms_item_id || undefined,
        slug: suggestionSlug(s.id),
        fieldData: { 'submitted-by': '', email: '' },
      }),
    );
  }
  stmts.push(
    env.DB.prepare(`UPDATE suggestions SET member_id = NULL, updated_at = ?2 WHERE member_id = ?1`).bind(memberId, now),
    // The member is no longer named on anyone else's story.
    env.DB.prepare(`DELETE FROM story_with WHERE member_id = ?1`).bind(memberId),
    env.DB.prepare(`UPDATE pledges SET buyer_email = NULL WHERE member_id = ?1`).bind(memberId),
    // Emails waiting to go to this member are not sent.
    env.DB.prepare(`UPDATE outbox SET status = 'cancelled', updated_at = ?2 WHERE member_id = ?1 AND target = 'email' AND status = 'pending'`).bind(memberId, now),
    env.DB.prepare(`DELETE FROM request_keys WHERE scope = ?1`).bind(`m:${memberId}`),
    env.DB.prepare(`DELETE FROM daily_usage WHERE member_id = ?1`).bind(memberId),
    env.DB.prepare(
      `UPDATE members SET shopify_customer_id = 'deleted:' || id, first_name = NULL, email = NULL,
         notify_invite_summary = 0, notify_story_approved = 0, notify_suggestion_live = 0, notify_pledge_reminder = 0,
         deleted_at = ?2, updated_at = ?2
       WHERE id = ?1`,
    ).bind(memberId, now),
  );
  await env.DB.batch(stmts);
  for (const s of stories.results) if (s.photo_key) await env.MEDIA.delete(s.photo_key);
  return { storiesRemoved: stories.results.length };
}

export async function deleteMemberByCustomerId(env: Env, deps: Deps, customerGid: string): Promise<boolean> {
  const m = await env.DB.prepare(`SELECT id FROM members WHERE shopify_customer_id = ?1`).bind(customerGid).first<{ id: number }>();
  if (!m) return false;
  await deleteMemberData(env, deps, m.id);
  return true;
}
