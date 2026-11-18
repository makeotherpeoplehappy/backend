// Review (Phase 2): Mickey sets Status in the Webflow CMS. A Webflow webhook,
// and a check every 15 minutes as a fallback, picks up the change:
//   Suggestions: Approved creates one draft action; publishing it emails the
//   member. Stories: Approved publishes the story and emails the member;
//   Rejected takes it off the site. Rejections send nothing.

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import type { Member } from '../identity';
import { memberEmail } from '../email';
import { word } from '../wording';
import { enqueue, registerTask } from '../queue';
import * as webflow from '../webflow';
import { suggestionSlug, titleFrom } from './submissions';
import { storySlug } from './stories';

type Status = 'new' | 'approved' | 'rejected';

function statusOf(optionId: unknown, ids: { new: string; approved: string; rejected: string }): Status | null {
  if (optionId === ids.approved) return 'approved';
  if (optionId === ids.rejected) return 'rejected';
  if (optionId === ids.new) return 'new';
  return null;
}

/** Records with writes still waiting in the queue are left alone until those are done. */
async function busyIds(env: Env, prefix: 'story' | 'suggestion'): Promise<Set<number>> {
  const r = await env.DB.prepare(`SELECT dedupe_key FROM outbox WHERE status IN ('pending', 'running') AND dedupe_key LIKE ?1`).bind(`${prefix}-%`).all<{ dedupe_key: string }>();
  const out = new Set<number>();
  for (const row of r.results) {
    const m = /^[a-z]+-[a-z]+:(\d+)/.exec(row.dedupe_key);
    if (m) out.add(Number(m[1]));
  }
  return out;
}

// ---------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------

async function memberById(env: Env, id: number | null): Promise<Member | null> {
  if (!id) return null;
  return env.DB.prepare(`SELECT * FROM members WHERE id = ?1 AND deleted_at IS NULL`).bind(id).first<Member>();
}

export async function applySuggestion(env: Env, deps: Deps, id: number, cmsId: string, status: Status) {
  const row = await env.DB.prepare(`SELECT id, status, draft_action_id FROM suggestions WHERE id = ?1`).bind(id).first<{ id: number; status: string; draft_action_id: string | null }>();
  if (!row) return null;
  const stmts: D1PreparedStatement[] = [];
  if (row.status !== status) stmts.push(env.DB.prepare(`UPDATE suggestions SET status = ?2, cms_item_id = COALESCE(cms_item_id, ?3), updated_at = ?4 WHERE id = ?1`).bind(id, status, cmsId, iso(deps.now())));
  // Approved (again or for the first time) yields one draft action at most.
  if (status === 'approved' && row.status !== 'approved' && !row.draft_action_id) {
    stmts.push(enqueue(env, deps, `suggestion-draft:${id}`, { op: 'task', name: 'suggestion.createDraft', target: 'webflow', args: { id } }));
  }
  if (stmts.length) await env.DB.batch(stmts);
  return row.status === status ? null : `${id}:${status}`;
}

let defaults: { time: string; cost: string } | null = null;
async function draftDefaults(env: Env, deps: Deps): Promise<{ time: string; cost: string }> {
  if (defaults) return defaults;
  const cached = (await env.CACHE.get('cfg:draft-defaults', 'json')) as { time: string; cost: string } | null;
  if (cached) return (defaults = cached);
  const fields = await webflow.getCollectionFields(env, deps, CMS.actions.id);
  const ref = (slug: string) => fields.find((f) => f.slug === slug)?.validations?.collectionId as string | undefined;
  const pick = async (collectionId: string | undefined, prefer: string[]) => {
    if (!collectionId) return '';
    const items = await webflow.listLiveItems(env, deps, collectionId);
    for (const p of prefer) {
      const hit = items.find((i) => i.fieldData.slug === p);
      if (hit) return hit.id;
    }
    return items[0]?.id || '';
  };
  defaults = { time: await pick(ref('time'), ['5-minutes', '15-minutes', '1-minute']), cost: await pick(ref('cost'), ['free']) };
  await env.CACHE.put('cfg:draft-defaults', JSON.stringify(defaults), { expirationTtl: 86_400 });
  return defaults;
}

const ONE_OFF = 'b978a0baf1c02f85abe1a684ba4c4c49';
export const draftSlug = (id: number) => `suggested-action-${id}`;

/** Creates the draft action for an approved suggestion and links the two. */
registerTask('suggestion.createDraft', async (env, deps, args) => {
  const id = Number(args.id);
  const s = await env.DB.prepare(`SELECT id, text, cms_item_id, draft_action_id, status FROM suggestions WHERE id = ?1`)
    .bind(id)
    .first<{ id: number; text: string; cms_item_id: string | null; draft_action_id: string | null; status: string }>();
  if (!s || s.draft_action_id || s.status !== 'approved') return 'ok';
  if (!s.cms_item_id) return 'defer';
  const d = await draftDefaults(env, deps);
  const item = await webflow.createItem(
    env,
    deps,
    CMS.actions.id,
    {
      name: titleFrom(s.text),
      slug: draftSlug(id),
      'short-answer': s.text.slice(0, 500),
      suggestion: s.cms_item_id,
      commitment: ONE_OFF,
      ...(d.time ? { time: d.time } : {}),
      ...(d.cost ? { cost: d.cost } : {}),
    },
    true,
  );
  await env.DB.prepare(`UPDATE suggestions SET draft_action_id = ?2, updated_at = ?3 WHERE id = ?1`).bind(id, item.id, iso(deps.now())).run();
  await webflow.updateItem(env, deps, CMS.suggestions.id, s.cms_item_id, { action: item.id });
  return 'ok';
});

/** A draft action deleted before it was published clears the suggestion's link. */
export async function draftActionDeleted(env: Env, deps: Deps, actionItemId: string) {
  const s = await env.DB.prepare(`SELECT id, cms_item_id FROM suggestions WHERE draft_action_id = ?1`).bind(actionItemId).first<{ id: number; cms_item_id: string | null }>();
  if (!s) return false;
  const live = await env.DB.prepare(`SELECT status FROM actions WHERE cms_item_id = ?1`).bind(actionItemId).first<{ status: string }>();
  if (live?.status === 'published') return false;
  await env.DB.batch([
    env.DB.prepare(`UPDATE suggestions SET draft_action_id = NULL, updated_at = ?2 WHERE id = ?1`).bind(s.id, iso(deps.now())),
    enqueue(env, deps, `suggestion-unlink:${s.id}:${iso(deps.now())}`, {
      op: 'webflow.update',
      collectionId: CMS.suggestions.id,
      itemId: s.cms_item_id || undefined,
      slug: suggestionSlug(s.id),
      fieldData: { action: null },
    }),
  ]);
  return true;
}

/** "Your action is live": once, when an action made from a suggestion is published. */
export async function notifySuggestionsLive(env: Env, deps: Deps, baseUrl: string) {
  const due = await env.DB.prepare(
    `SELECT s.id, s.member_id AS memberId, a.title, a.slug FROM suggestions s JOIN actions a ON a.suggestion_cms_id = s.cms_item_id
     WHERE a.status = 'published' AND s.live_notified_at IS NULL LIMIT 50`,
  ).all<{ id: number; memberId: number | null; title: string; slug: string }>();
  const site = baseUrl.replace(/\/join$/, '');
  let sent = 0;
  for (const d of due.results) {
    const stmts = [env.DB.prepare(`UPDATE suggestions SET live_notified_at = ?2 WHERE id = ?1`).bind(d.id, iso(deps.now()))];
    const member = await memberById(env, d.memberId);
    const msg = member ? await memberEmail(env, member, 'suggestion_live', { actionTitle: d.title, actionUrl: `${site}/action/${d.slug}` }, baseUrl) : null;
    if (msg) {
      stmts.push(enqueue(env, deps, `suggestion-live:${d.id}`, { op: 'email.send', message: msg }, d.memberId));
      sent++;
    }
    await env.DB.batch(stmts);
  }
  return { sent };
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

export async function applyStory(env: Env, deps: Deps, id: number, cmsId: string, status: Status, baseUrl: string) {
  const row = await env.DB.prepare(`SELECT id, member_id, action_id, status, version, approved_version FROM stories WHERE id = ?1`)
    .bind(id)
    .first<{ id: number; member_id: number; action_id: string; status: string; version: number; approved_version: number | null }>();
  if (!row || row.status === status) return null;
  const now = iso(deps.now());
  const stmts: D1PreparedStatement[] = [env.DB.prepare(`UPDATE stories SET status = ?2, cms_item_id = COALESCE(cms_item_id, ?3), updated_at = ?4 WHERE id = ?1`).bind(id, status, cmsId, now)];
  if (status === 'approved') {
    stmts.push(
      env.DB.prepare(`UPDATE stories SET approved_version = ?2 WHERE id = ?1`).bind(id, row.version),
      enqueue(env, deps, `story-publish:${id}:v${row.version}`, { op: 'webflow.publish', collectionId: CMS.stories.id, itemId: cmsId }),
    );
    if (row.approved_version !== row.version) {
      const member = await memberById(env, row.member_id);
      const action = await env.DB.prepare(`SELECT title, slug, status FROM actions WHERE cms_item_id = ?1`).bind(row.action_id).first<{ title: string; slug: string; status: string }>();
      const site = baseUrl.replace(/\/join$/, '');
      const msg = member
        ? await memberEmail(env, member, 'story_approved', { actionTitle: action?.title, actionUrl: action?.status === 'published' ? `${site}/action/${action.slug}` : `${site}/stories` }, baseUrl)
        : null;
      if (msg) stmts.push(enqueue(env, deps, `story-approved:${id}:v${row.version}`, { op: 'email.send', message: msg }, row.member_id));
    }
  } else {
    stmts.push(enqueue(env, deps, `story-takedown:${id}:${now}`, { op: 'webflow.removeFromLive', collectionId: CMS.stories.id, itemId: cmsId }));
    // A video that won't be shown: a friendly email, never silence.
    if (status === 'rejected') {
      const v = await env.DB.prepare(`SELECT video_key FROM stories WHERE id = ?1`).bind(id).first<{ video_key: string | null }>();
      const member = v?.video_key ? await memberById(env, row.member_id) : null;
      if (member?.email && !member.deleted_at) {
        const action = await env.DB.prepare(`SELECT title FROM actions WHERE cms_item_id = ?1`).bind(row.action_id).first<{ title: string }>();
        const site = baseUrl.replace(/\/join$/, '');
        stmts.push(
          enqueue(env, deps, `video-not-used:${id}:v${row.version}`, {
            op: 'email.send',
            message: {
              to: member.email,
              subject: word('video-not-used-subject'),
              text: word('video-not-used-body', { name: member.first_name || word('video-not-used-there'), action: action?.title || word('video-not-used-your-action'), url: `${site}/share-your-story` }),
              tags: [{ name: 'kind', value: 'video_not_used' }],
            },
          }, row.member_id),
        );
      }
    }
  }
  await env.DB.batch(stmts);
  return `${id}:${status}`;
}

// ---------------------------------------------------------------------------
// One item (webhook) or everything (every 15 minutes)
// ---------------------------------------------------------------------------

const idFromSlug = (slug: unknown, prefix: string): number | null => {
  const m = new RegExp(`^${prefix}-(\\d+)$`).exec(String(slug || ''));
  return m ? Number(m[1]) : null;
};

export async function reviewItem(env: Env, deps: Deps, collectionId: string, item: webflow.WebflowItem, baseUrl: string) {
  if (collectionId === CMS.suggestions.id) {
    const id = idFromSlug(item.fieldData.slug, 'suggestion');
    const st = statusOf(item.fieldData.status, CMS.suggestions.status);
    if (id === null || !st || (await busyIds(env, 'suggestion')).has(id)) return null;
    return applySuggestion(env, deps, id, item.id, st);
  }
  if (collectionId === CMS.stories.id) {
    const id = idFromSlug(item.fieldData.slug, 'story');
    const st = statusOf(item.fieldData.status, CMS.stories.status);
    if (id === null || !st || (await busyIds(env, 'story')).has(id)) return null;
    return applyStory(env, deps, id, item.id, st, baseUrl);
  }
  return null;
}

export async function reviewAll(env: Env, deps: Deps, baseUrl: string) {
  const changes: string[] = [];
  for (const collectionId of [CMS.suggestions.id, CMS.stories.id]) {
    for (const item of await webflow.listAllItems(env, deps, collectionId)) {
      const c = await reviewItem(env, deps, collectionId, item, baseUrl);
      if (c) changes.push(c);
    }
  }
  // Drafts made from suggestions that were deleted before being published.
  const drafts = await env.DB.prepare(
    `SELECT s.draft_action_id AS id FROM suggestions s LEFT JOIN actions a ON a.cms_item_id = s.draft_action_id
     WHERE s.draft_action_id IS NOT NULL AND (a.status IS NULL OR a.status != 'published') LIMIT 50`,
  ).all<{ id: string }>();
  for (const d of drafts.results) {
    if (!(await webflow.getItem(env, deps, CMS.actions.id, d.id)) && (await draftActionDeleted(env, deps, d.id))) changes.push(`draft ${d.id} removed`);
  }
  return { changes, notified: await notifySuggestionsLive(env, deps, baseUrl) };
}

export { storySlug };

// ---------------------------------------------------------------------------
// Reviewing from /lab: anyone with Lab access can approve or reject. The
// decision is written to the CMS Status first (so Webflow stays the record),
// then applied exactly as if it had been made in the CMS.
// ---------------------------------------------------------------------------

export async function reviewQueue(env: Env) {
  const suggestions = await env.DB.prepare(
    `SELECT s.id, s.text, s.similar_notes AS similar, s.created_at AS createdAt, s.cms_item_id IS NOT NULL AS ready,
       COALESCE(m.share_name, m.first_name) AS name
     FROM suggestions s LEFT JOIN members m ON m.id = s.member_id
     WHERE s.status = 'new' ORDER BY s.created_at LIMIT 50`,
  ).all();
  const stories = await env.DB.prepare(
    `SELECT s.id, s.text, s.photo_key AS photoKey, s.photo_description AS photoDescription, s.video_url AS videoUrl, s.show_name AS showName,
       s.created_at AS createdAt, s.version, s.cms_item_id IS NOT NULL AS ready, COALESCE(m.share_name, m.first_name) AS name,
       a.title AS actionTitle, CASE WHEN a.status = 'published' THEN a.slug END AS actionSlug,
       s.video_key AS videoKey, s.poster_key AS posterKey, s.video_codec AS videoCodec, s.has_children AS hasChildren
     FROM stories s JOIN members m ON m.id = s.member_id LEFT JOIN actions a ON a.cms_item_id = s.action_id
     WHERE s.status = 'new' ORDER BY s.created_at LIMIT 50`,
  ).all();
  return { suggestions: suggestions.results, stories: stories.results };
}

export async function labDecide(env: Env, deps: Deps, reviewer: string, body: { type?: unknown; id?: unknown; decision?: unknown }, baseUrl: string) {
  const type = body.type === 'story' ? 'story' : body.type === 'suggestion' ? 'suggestion' : null;
  const decision = body.decision === 'approved' ? 'approved' : body.decision === 'rejected' ? 'rejected' : null;
  const id = Number(body.id);
  if (!type || !decision || !Number.isInteger(id)) throw new HttpError(400, 'invalid_review', 'That decision could not be read.');
  const table = type === 'story' ? 'stories' : 'suggestions';
  const row = await env.DB.prepare(`SELECT id, status, cms_item_id FROM ${table} WHERE id = ?1`).bind(id).first<{ id: number; status: string; cms_item_id: string | null }>();
  if (!row) throw new HttpError(404, 'not_found', 'err-not-found');
  if (row.status !== 'new') throw new HttpError(409, 'already_reviewed', 'Someone has already reviewed this.');
  if (!row.cms_item_id) throw new HttpError(409, 'not_ready', 'err-not-ready');
  const collection = type === 'story' ? CMS.stories : CMS.suggestions;
  await webflow.updateItem(env, deps, collection.id, row.cms_item_id, { status: collection.status[decision] });
  if (type === 'story') await applyStory(env, deps, id, row.cms_item_id, decision, baseUrl);
  else await applySuggestion(env, deps, id, row.cms_item_id, decision);
  await env.DB.prepare(`UPDATE ${table} SET reviewed_by = ?2, reviewed_at = ?3 WHERE id = ?1`).bind(id, reviewer, iso(deps.now())).run();
  return { type, id, decision };
}
