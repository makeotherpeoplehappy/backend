import { CMS, EMAIL_KINDS, type EmailKind } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import type { Member } from '../identity';
import { enqueue } from '../queue';
import { memberTally } from './actions';
import { storyRemovalStatements, suggestionSlug } from './submissions';
import { memberPledges } from './pledges';
import { displayName, memberRipple } from './ripple';

export async function getAccount(env: Env, member: Member) {
  const done = await env.DB.prepare(
    `SELECT d.action_id AS actionId, d.action_title AS title, d.done_at AS doneAt, a.slug AS slug, a.status AS actionStatus
     FROM done_marks d LEFT JOIN actions a ON a.cms_item_id = d.action_id
     WHERE d.member_id = ?1 ORDER BY d.done_at DESC LIMIT 500`,
  )
    .bind(member.id)
    .all();
  // "Save" on an action page is a like (value 1); the account lists them so
  // members can come back to actions they meant to do.
  const saved = await env.DB.prepare(
    `SELECT l.action_id AS actionId, a.title AS title, a.slug AS slug, l.updated_at AS savedAt
     FROM likes l JOIN actions a ON a.cms_item_id = l.action_id
     WHERE l.member_id = ?1 AND l.value = 1 AND a.status = 'published' ORDER BY l.updated_at DESC LIMIT 200`,
  )
    .bind(member.id)
    .all();
  const stories = await env.DB.prepare(
    `SELECT s.id, s.action_id AS actionId, s.status, s.created_at AS createdAt, a.title AS actionTitle, a.slug AS actionSlug
     FROM stories s LEFT JOIN actions a ON a.cms_item_id = s.action_id WHERE s.member_id = ?1 ORDER BY s.created_at DESC`,
  )
    .bind(member.id)
    .all();
  const suggestions = await env.DB.prepare(`SELECT id, text, status, created_at AS createdAt FROM suggestions WHERE member_id = ?1 ORDER BY created_at DESC`)
    .bind(member.id)
    .all();
  return {
    firstName: member.first_name,
    name: displayName(member),
    tally: await memberTally(env, member.id),
    pledges: await memberPledges(env, member.id),
    ...(await memberRipple(env, member.id)),
    done: done.results,
    saved: saved.results,
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

export async function updateSettings(env: Env, deps: Deps, member: Member, body: { notifications?: Record<string, unknown>; firstName?: unknown }) {
  const changes = body.notifications || {};
  const sets: string[] = [];
  const values: unknown[] = [];
  if (body.firstName !== undefined) {
    const name = typeof body.firstName === 'string' ? body.firstName.trim().replace(/\s+/g, ' ') : '';
    if (!name || name.length > 40 || /[<>@]/.test(name)) throw new HttpError(400, 'invalid_name', 'err-invalid-name');
    values.push(name);
    sets.push(`share_name = ?${values.length}`);
  }
  for (const [kind, value] of Object.entries(changes)) {
    if (!(kind in EMAIL_KINDS) || typeof value !== 'boolean') {
      throw new HttpError(400, 'invalid_setting', 'err-invalid-setting');
    }
    values.push(value ? 1 : 0);
    sets.push(`${EMAIL_KINDS[kind as EmailKind]} = ?${values.length}`);
  }
  if (!sets.length) return { settings: settingsOf(member), name: displayName(member) };
  values.push(iso(deps.now()), member.id);
  const row = await env.DB.prepare(`UPDATE members SET ${sets.join(', ')}, updated_at = ?${values.length - 1} WHERE id = ?${values.length} RETURNING *`)
    .bind(...values)
    .first<Member>();
  return { settings: settingsOf(row!), name: displayName(row!) };
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
      `UPDATE members SET account_id = 'deleted:' || id, first_name = NULL, email = NULL, share_name = NULL,
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
  const m = await env.DB.prepare(`SELECT id FROM members WHERE account_id = ?1`).bind(customerGid).first<{ id: number }>();
  if (!m) return false;
  await deleteMemberData(env, deps, m.id);
  return true;
}
