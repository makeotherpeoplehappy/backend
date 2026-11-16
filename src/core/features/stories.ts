// Stories (Phase 2): one per member per done action, with text, a photo, a
// video link or any mix. Each is reviewed in the Webflow CMS before it shows.

import { CMS } from '../config';
import type { Deps, Env } from '../env';
import { HttpError, base64url, iso } from '../http';
import type { Member } from '../identity';
import { enqueue } from '../queue';
import { consumeDaily, refundDaily } from '../safety';
import { getAction } from './actions';

const MAX_STORY = 5000;
const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const MAX_DESCRIPTION = 300;
export const storySlug = (id: number) => `story-${id}`;
export const storyCreateKey = (id: number) => `story-create:${id}`;

function cleanText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\r\n/g, '\n').trim().slice(0, max) : '';
}

// ---------------------------------------------------------------------------
// Video links: YouTube, TikTok, Instagram or Vimeo only, shown muted, and
// vertical clips in a vertical player.
// ---------------------------------------------------------------------------

export interface Video {
  url: string;
  provider: 'youtube' | 'tiktok' | 'instagram' | 'vimeo';
  embed: string;
  vertical: boolean;
}

export function parseVideo(raw: unknown): Video | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const host = u.hostname.replace(/^(www\.|m\.)/, '');
  const path = u.pathname;
  let m: RegExpExecArray | null;
  if (host === 'youtube.com' && (m = /^\/shorts\/([\w-]{6,20})/.exec(path))) {
    return { url: `https://www.youtube.com/shorts/${m[1]}`, provider: 'youtube', embed: `https://www.youtube-nocookie.com/embed/${m[1]}?mute=1&playsinline=1`, vertical: true };
  }
  if (host === 'youtube.com' && path === '/watch' && /^[\w-]{6,20}$/.test(u.searchParams.get('v') || '')) {
    const id = u.searchParams.get('v');
    return { url: `https://www.youtube.com/watch?v=${id}`, provider: 'youtube', embed: `https://www.youtube-nocookie.com/embed/${id}?mute=1&playsinline=1`, vertical: false };
  }
  if (host === 'youtu.be' && (m = /^\/([\w-]{6,20})$/.exec(path))) {
    return { url: `https://www.youtube.com/watch?v=${m[1]}`, provider: 'youtube', embed: `https://www.youtube-nocookie.com/embed/${m[1]}?mute=1&playsinline=1`, vertical: false };
  }
  if (host === 'tiktok.com' && (m = /^\/@[\w.-]+\/video\/(\d{5,25})/.exec(path))) {
    return { url: `https://www.tiktok.com${m[0]}`, provider: 'tiktok', embed: `https://www.tiktok.com/embed/v2/${m[1]}?muted=1`, vertical: true };
  }
  if (host === 'instagram.com' && (m = /^\/(p|reel|reels)\/([\w-]{5,40})/.exec(path))) {
    const kind = m[1] === 'p' ? 'p' : 'reel';
    return { url: `https://www.instagram.com/${kind}/${m[2]}/`, provider: 'instagram', embed: `https://www.instagram.com/${kind}/${m[2]}/embed`, vertical: kind === 'reel' };
  }
  if (host === 'vimeo.com' && (m = /^\/(\d{5,15})/.exec(path))) {
    return { url: `https://vimeo.com/${m[1]}`, provider: 'vimeo', embed: `https://player.vimeo.com/video/${m[1]}?muted=1`, vertical: false };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Photos. The browser resizes and converts the photo to JPEG; the server
// accepts JPEG only and strips every metadata block (location included).
// ---------------------------------------------------------------------------

/** Removes EXIF, XMP, comments and other metadata segments from a JPEG. */
export function stripJpegMetadata(bytes: Uint8Array): Uint8Array | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const out: Uint8Array[] = [bytes.subarray(0, 2)];
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    if (marker === 0xd9) break;
    if (marker === 0xda) {
      out.push(bytes.subarray(i));
      i = bytes.length;
      break;
    }
    const len = (bytes[i + 2] << 8) | bytes[i + 3];
    if (len < 2 || i + 2 + len > bytes.length) return null;
    // APP1..APP15 (EXIF, XMP, ICC...) and comments are dropped; APP0 (JFIF) kept.
    const drop = (marker >= 0xe1 && marker <= 0xef) || marker === 0xfe;
    if (!drop) out.push(bytes.subarray(i, i + 2 + len));
    i += 2 + len;
  }
  if (i < bytes.length) return null;
  const total = out.reduce((n, b) => n + b.length, 0);
  const result = new Uint8Array(total);
  let o = 0;
  for (const b of out) {
    result.set(b, o);
    o += b.length;
  }
  return result;
}

export async function uploadPhoto(env: Env, deps: Deps, member: Member, req: Request) {
  const type = (req.headers.get('Content-Type') || '').split(';')[0].trim().toLowerCase();
  if (type !== 'image/jpeg') throw new HttpError(415, 'photo_type', 'err-photo-type');
  const declared = Number(req.headers.get('Content-Length') || '0');
  if (declared > MAX_PHOTO_BYTES) throw new HttpError(413, 'photo_too_large', 'err-photo-too-large');
  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.length > MAX_PHOTO_BYTES) throw new HttpError(413, 'photo_too_large', 'err-photo-too-large');
  const clean = stripJpegMetadata(raw);
  if (!clean) throw new HttpError(415, 'photo_type', 'err-photo-unreadable');
  const dayKey = `uploads:${member.id}:${iso(deps.now()).slice(0, 10)}`;
  const used = Number((await env.CACHE.get(dayKey)) || '0');
  if (used >= 30) throw new HttpError(429, 'daily_limit', 'err-limit-photos');
  await env.CACHE.put(dayKey, String(used + 1), { expirationTtl: 2 * 86_400 });
  const key = `stories/${base64url(crypto.getRandomValues(new Uint8Array(18)))}.jpg`;
  await env.MEDIA.put(key, clean, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000, immutable' } });
  await env.CACHE.put(`upload:${key}`, String(member.id), { expirationTtl: 2 * 86_400 });
  return { photoKey: key };
}

/** Serves a story photo from object storage. */
export async function servePhoto(env: Env, key: string): Promise<Response> {
  if (!/^stories\/[A-Za-z0-9_-]{20,40}\.jpg$/.test(key)) return new Response('Not found', { status: 404 });
  const obj = await env.MEDIA.get(key);
  if (!obj) return new Response('Not found', { status: 404 });
  return new Response(obj.body, { headers: { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=31536000, immutable' } });
}

// ---------------------------------------------------------------------------
// Sending and editing
// ---------------------------------------------------------------------------

export interface StoryInput {
  actionId?: unknown;
  text?: unknown;
  photoKey?: unknown;
  photoDescription?: unknown;
  videoUrl?: unknown;
  withMemberIds?: unknown;
  showName?: unknown;
  consent?: unknown;
}

/** Members who tapped "I'm in" on this member's invites for this action. */
export async function withCandidates(env: Env, memberId: number, actionId: string) {
  const r = await env.DB.prepare(
    `SELECT DISTINCT m.id, COALESCE(m.share_name, m.first_name) AS name
     FROM invites i JOIN invite_joins j ON j.invite_code = i.code JOIN members m ON m.id = j.member_id
     WHERE i.inviter_id = ?1 AND i.action_id = ?2 AND j.left_at IS NULL AND m.deleted_at IS NULL`,
  )
    .bind(memberId, actionId)
    .all<{ id: number; name: string | null }>();
  return r.results.filter((x) => x.name);
}

interface StoryRow {
  id: number;
  member_id: number;
  action_id: string;
  cms_item_id: string | null;
  photo_key: string | null;
  status: string;
  version: number;
}

export async function saveStory(env: Env, deps: Deps, member: Member, body: StoryInput, baseUrl: string) {
  const actionId = typeof body.actionId === 'string' ? body.actionId : '';
  const action = actionId ? await getAction(env, deps, actionId) : null;
  if (!action) throw new HttpError(404, 'action_not_found', 'err-action-not-found');
  const done = await env.DB.prepare(`SELECT 1 AS ok FROM done_marks WHERE member_id = ?1 AND action_id = ?2 LIMIT 1`).bind(member.id, actionId).first();
  if (!done) throw new HttpError(403, 'not_done', 'err-story-needs-done');

  const text = cleanText(body.text, MAX_STORY);
  const video = body.videoUrl ? parseVideo(body.videoUrl) : null;
  if (body.videoUrl && String(body.videoUrl).trim() && !video) {
    throw new HttpError(400, 'invalid_video', 'err-invalid-video');
  }
  const existing = await env.DB.prepare(`SELECT * FROM stories WHERE member_id = ?1 AND action_id = ?2`).bind(member.id, actionId).first<StoryRow>();
  let photoKey: string | null = existing?.photo_key ?? null;
  if (body.photoKey === null || body.photoKey === '') photoKey = null;
  else if (typeof body.photoKey === 'string' && body.photoKey !== existing?.photo_key) {
    const owner = await env.CACHE.get(`upload:${body.photoKey}`);
    if (owner !== String(member.id)) throw new HttpError(400, 'invalid_photo', 'err-invalid-photo');
    photoKey = body.photoKey;
  }
  if (!text && !photoKey && !video) throw new HttpError(400, 'empty_story', 'err-empty-story');
  if (body.consent !== true) throw new HttpError(400, 'consent_required', 'err-consent-required');
  const showName = body.showName !== false;
  const name = member.share_name || member.first_name || '';
  const description = cleanText(body.photoDescription, MAX_DESCRIPTION) || (photoKey ? `Photo from ${showName && name ? `${name}'s` : 'a'} story` : '');

  const allowed = new Set((await withCandidates(env, member.id, actionId)).map((c) => c.id));
  const withIds = Array.isArray(body.withMemberIds) ? [...new Set(body.withMemberIds.map(Number))] : [];
  for (const id of withIds) if (!allowed.has(id)) throw new HttpError(400, 'invalid_with', 'err-invalid-with');

  const now = iso(deps.now());
  const fieldData: Record<string, unknown> = {
    name: `${showName && name ? name : 'A member'}: ${action.title}`.slice(0, 256),
    story: text,
    action: actionId,
    'submitted-by': showName ? name : '',
    email: member.email || '',
    'submitted-on': now,
    status: CMS.stories.status.new,
    photo: photoKey ? { url: `${baseUrl}/media/${photoKey}`, alt: description } : null,
    video: video && (video.provider === 'youtube' || video.provider === 'vimeo') ? video.url : null,
  };
  const withStmts = (id: number) => [
    env.DB.prepare(`DELETE FROM story_with WHERE story_id = ?1`).bind(id),
    ...withIds.map((m) => env.DB.prepare(`INSERT INTO story_with (story_id, member_id) VALUES (?1, ?2)`).bind(id, m)),
  ];

  if (existing) {
    // An edit goes back to review and comes off the site until approved again.
    const version = existing.version + 1;
    await env.DB.batch([
      env.DB.prepare(
        `UPDATE stories SET text = ?2, photo_key = ?3, photo_description = ?4, video_url = ?5, show_name = ?6, status = 'new', version = ?7, updated_at = ?8 WHERE id = ?1`,
      ).bind(existing.id, text, photoKey, description || null, video?.url ?? null, showName ? 1 : 0, version, now),
      ...withStmts(existing.id),
      enqueue(env, deps, `story-edit:${existing.id}:v${version}`, {
        op: 'webflow.update',
        collectionId: CMS.stories.id,
        itemId: existing.cms_item_id || undefined,
        slug: storySlug(existing.id),
        fieldData: { ...fieldData, slug: storySlug(existing.id) },
      }, member.id),
      enqueue(env, deps, `story-unpublish:${existing.id}:v${version}`, {
        op: 'webflow.removeFromLive',
        collectionId: CMS.stories.id,
        itemId: existing.cms_item_id || undefined,
        slug: storySlug(existing.id),
        afterCreate: storyCreateKey(existing.id),
      }),
    ]);
    if (existing.photo_key && existing.photo_key !== photoKey) await env.MEDIA.delete(existing.photo_key);
    return { id: existing.id, status: 'new', edited: true };
  }

  await consumeDaily(env, deps, member.id, 'story');
  let id: number | null = null;
  try {
    const row = await env.DB.prepare(
      `INSERT INTO stories (member_id, action_id, text, photo_key, photo_description, video_url, show_name, status, created_at, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'new', ?8, ?8) RETURNING id`,
    )
      .bind(member.id, actionId, text, photoKey, description || null, video?.url ?? null, showName ? 1 : 0, now)
      .first<{ id: number }>();
    id = row!.id;
    await env.DB.batch([
      ...withStmts(id),
      enqueue(
        env,
        deps,
        storyCreateKey(id),
        { op: 'webflow.create', collectionId: CMS.stories.id, isDraft: true, fieldData: { ...fieldData, slug: storySlug(id) } as never, saveIdTo: { table: 'stories', id } },
        member.id,
      ),
    ]);
    return { id, status: 'new', edited: false };
  } catch (e) {
    if (id !== null) await env.DB.batch([env.DB.prepare(`DELETE FROM story_with WHERE story_id = ?1`).bind(id), env.DB.prepare(`DELETE FROM stories WHERE id = ?1`).bind(id)]);
    await refundDaily(env, deps, member.id, 'story');
    if (String((e as Error).message).includes('UNIQUE')) throw new HttpError(409, 'story_exists', 'err-story-exists');
    throw e;
  }
}

/** Statements that take a story off the site and out of the database. */
export function storyRemovalStatements(env: Env, deps: Deps, story: { id: number; cms_item_id: string | null }): D1PreparedStatement[] {
  return [
    // If the CMS item was never created, its queued create is cancelled.
    env.DB.prepare(`UPDATE outbox SET status = 'cancelled', updated_at = ?2 WHERE dedupe_key = ?1 AND status = 'pending'`).bind(storyCreateKey(story.id), iso(deps.now())),
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
  const story = await env.DB.prepare(`SELECT id, member_id, cms_item_id, photo_key FROM stories WHERE id = ?1`)
    .bind(storyId)
    .first<{ id: number; member_id: number; cms_item_id: string | null; photo_key: string | null }>();
  if (!story || story.member_id !== member.id) throw new HttpError(404, 'story_not_found', 'err-story-not-found');
  await env.DB.batch(storyRemovalStatements(env, deps, story));
  if (story.photo_key) await env.MEDIA.delete(story.photo_key);
  return { deleted: true };
}

/** The member's own story for an action, for the edit form. */
export async function myStory(env: Env, member: Member, actionId: string) {
  const s = await env.DB.prepare(
    `SELECT id, text, photo_key AS photoKey, photo_description AS photoDescription, video_url AS videoUrl, show_name AS showName, status
     FROM stories WHERE member_id = ?1 AND action_id = ?2`,
  )
    .bind(member.id, actionId)
    .first<Record<string, unknown>>();
  const withIds = s ? (await env.DB.prepare(`SELECT member_id FROM story_with WHERE story_id = ?1`).bind(s.id).all<{ member_id: number }>()).results.map((r) => r.member_id) : [];
  const done = await env.DB.prepare(`SELECT 1 AS ok FROM done_marks WHERE member_id = ?1 AND action_id = ?2 LIMIT 1`).bind(member.id, actionId).first();
  return {
    done: !!done,
    story: s ? { ...s, showName: s.showName === 1, withMemberIds: withIds } : null,
    withCandidates: await withCandidates(env, member.id, actionId),
    name: member.share_name || member.first_name || null,
  };
}

// ---------------------------------------------------------------------------
// Showing stories
// ---------------------------------------------------------------------------

export async function storiesFor(env: Env, opts: { actionId?: string; limit?: number; offset?: number }) {
  const limit = Math.min(opts.limit ?? 20, 50);
  const where = opts.actionId ? `AND s.action_id = ?3` : '';
  const stmt = env.DB.prepare(
    `SELECT s.id, s.text, s.photo_key AS photoKey, s.photo_description AS photoDescription, s.video_url AS videoUrl, s.created_at AS createdAt,
       CASE WHEN s.show_name = 1 THEN COALESCE(m.share_name, m.first_name) END AS name,
       COALESCE(a.title, (SELECT action_title FROM done_marks d WHERE d.member_id = s.member_id AND d.action_id = s.action_id LIMIT 1)) AS actionTitle,
       CASE WHEN a.status = 'published' THEN a.slug END AS actionSlug
     FROM stories s JOIN members m ON m.id = s.member_id LEFT JOIN actions a ON a.cms_item_id = s.action_id
     WHERE s.status = 'approved' ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT ?1 OFFSET ?2`,
  );
  const rows = await (opts.actionId ? stmt.bind(limit, opts.offset ?? 0, opts.actionId) : stmt.bind(limit, opts.offset ?? 0)).all<Record<string, unknown>>();
  const out = [];
  for (const r of rows.results) {
    const withNames = (
      await env.DB.prepare(`SELECT COALESCE(m.share_name, m.first_name) AS name FROM story_with w JOIN members m ON m.id = w.member_id WHERE w.story_id = ?1 AND m.deleted_at IS NULL`)
        .bind(r.id)
        .all<{ name: string | null }>()
    ).results
      .map((x) => x.name)
      .filter(Boolean);
    out.push({
      id: r.id,
      text: r.text || '',
      photo: r.photoKey ? { key: r.photoKey, description: r.photoDescription || null } : null, // the site words a missing description
      video: r.videoUrl ? parseVideo(r.videoUrl) : null,
      name: r.name || null,
      with: withNames,
      createdAt: r.createdAt,
      action: { title: r.actionTitle || '', slug: r.actionSlug || null },
    });
  }
  return out;
}

/** "Report this story": emails Mickey, at most once an hour per story. */
export async function reportStory(env: Env, deps: Deps, storyId: number, reason: unknown) {
  const s = await env.DB.prepare(`SELECT id, cms_item_id, text, status FROM stories WHERE id = ?1`).bind(storyId).first<{ id: number; cms_item_id: string | null; text: string; status: string }>();
  if (!s || s.status !== 'approved') throw new HttpError(404, 'story_not_found', 'err-story-not-found');
  const key = `report:${storyId}:${iso(deps.now()).slice(0, 13)}`;
  if (await env.CACHE.get(key)) return { reported: true };
  await env.CACHE.put(key, '1', { expirationTtl: 3600 });
  const why = cleanText(reason, 1000);
  await enqueue(env, deps, `story-report:${storyId}:${iso(deps.now())}`, {
    op: 'email.send',
    message: {
      to: env.ERROR_EMAIL_TO,
      subject: `A story was reported (story ${storyId})`,
      text: `Someone reported story ${storyId}.\n\nReason: ${why || '(none given)'}\n\nStory text:\n${s.text || '(no text)'}\n\nReview it in Webflow: CMS > Stories > ${storySlug(storyId)}${s.cms_item_id ? ` (item ${s.cms_item_id})` : ''}. Set Status to Rejected to take it down.`,
    },
  }).run();
  return { reported: true };
}
