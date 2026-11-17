// Ripple (Phase 4): invites, "I'm in", the daily summary email and "Your
// actions led to N more". One mechanic: a record of one member's action
// leading to another's.

import { word } from '../wording';
import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import type { Member } from '../identity';
import { memberEmail } from '../email';
import { enqueue } from '../queue';
import { consumeDaily } from '../safety';
import { getAction } from './actions';

export const displayName = (m: { share_name?: string | null; first_name?: string | null }) => m.share_name || m.first_name || null;

const CODE = /^[A-Za-z0-9]{10}$/;
export const NOTE_MAX = 280;
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';

function newCode(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(10));
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

export const isInviteCode = (s: string) => CODE.test(s);

/** "Your actions led to N more": marks by everyone below the member in the chain, made after they joined. */
export async function rippleTotal(env: Env, memberId: number): Promise<number> {
  const key = `ripple:${memberId}`;
  const cached = await env.CACHE.get(key);
  if (cached !== null) return Number(cached);
  const r = await env.DB.prepare(
    `WITH RECURSIVE tree(id, depth) AS (
       SELECT id, 1 FROM members WHERE inviter_id = ?1
       UNION SELECT m.id, t.depth + 1 FROM members m JOIN tree t ON m.inviter_id = t.id WHERE t.depth < 50
     )
     SELECT COUNT(*) AS n FROM done_marks d JOIN members m ON m.id = d.member_id
     WHERE d.member_id IN (SELECT id FROM tree) AND m.inviter_joined_at IS NOT NULL AND d.done_at >= m.inviter_joined_at`,
  )
    .bind(memberId)
    .first<{ n: number }>();
  const n = r?.n ?? 0;
  await env.CACHE.put(key, String(n), { expirationTtl: 60 });
  return n;
}

/** People linked to the member by an invite for this action who also did it: "Done together with Ana". */
export async function doneWithNames(env: Env, memberId: number, actionId: string): Promise<string[]> {
  const r = await env.DB.prepare(
    `SELECT DISTINCT COALESCE(m.share_name, m.first_name) AS name FROM invites i JOIN invite_joins j ON j.invite_code = i.code
     JOIN members m ON m.id = CASE WHEN i.inviter_id = ?1 THEN j.member_id ELSE i.inviter_id END
     WHERE i.action_id = ?2 AND j.left_at IS NULL AND (i.inviter_id = ?1 OR j.member_id = ?1) AND m.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM done_marks d WHERE d.member_id = m.id AND d.action_id = ?2)`,
  )
    .bind(memberId, actionId)
    .all<{ name: string | null }>();
  return r.results.map((x) => x.name).filter((x): x is string => !!x);
}

export async function createInvite(env: Env, deps: Deps, member: Member, body: { actionId?: unknown; kind?: unknown; note?: unknown }, baseUrl: string) {
  const name = displayName(member);
  if (!name) throw new HttpError(409, 'need_first_name', 'err-need-first-name');
  const actionId = typeof body.actionId === 'string' ? body.actionId : '';
  const action = actionId ? await getAction(env, deps, actionId) : null;
  if (!action || action.status !== 'published') throw new HttpError(404, 'action_not_found', 'err-action-not-found');
  const kind = body.kind === 'pass_it_on' ? 'pass_it_on' : 'with_me';
  if (kind === 'with_me' && action.can_do_with_others !== 1) throw new HttpError(400, 'not_with_others', 'err-not-with-others');
  if (kind === 'pass_it_on') {
    const done = await env.DB.prepare(`SELECT 1 AS x FROM done_marks WHERE member_id = ?1 AND action_id = ?2 LIMIT 1`).bind(member.id, actionId).first();
    if (!done) throw new HttpError(403, 'not_done', 'err-pass-needs-done');
  }
  const note = typeof body.note === 'string' ? body.note.replace(/\s+/g, ' ').trim().slice(0, NOTE_MAX) || null : null;
  let row = await env.DB.prepare(`SELECT code FROM invites WHERE inviter_id = ?1 AND action_id = ?2 AND kind = ?3`).bind(member.id, actionId, kind).first<{ code: string }>();
  if (!row) {
    await consumeDaily(env, deps, member.id, 'invite');
    const code = newCode();
    await env.DB.prepare(`INSERT INTO invites (code, inviter_id, action_id, kind, created_at, note) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`).bind(code, member.id, actionId, kind, iso(deps.now()), note).run();
    row = { code };
  } else if (body.note !== undefined) {
    // The latest note is what the invite page and link preview show.
    await env.DB.prepare(`UPDATE invites SET note = ?2 WHERE code = ?1`).bind(row.code, note).run();
  }
  const intro = kind === 'with_me' ? `${name} wants to do this with you: ${action.title}` : `${name} did this and is passing it on: ${action.title}`;
  const text = note ? `${note}\n\n${intro}` : intro;
  return { code: row.code, url: `${baseUrl}/${row.code}`, text, kind, note };
}

async function inviteRow(env: Env, code: string) {
  if (!CODE.test(code)) return null;
  return env.DB.prepare(
    `SELECT i.code, i.kind, i.note, i.action_id AS actionId, i.inviter_id AS inviterId, COALESCE(m.share_name, m.first_name) AS inviterName, m.deleted_at AS inviterDeleted
     FROM invites i JOIN members m ON m.id = i.inviter_id WHERE i.code = ?1`,
  )
    .bind(code)
    .first<{ code: string; kind: string; note: string | null; actionId: string; inviterId: number; inviterName: string | null; inviterDeleted: string | null }>();
}

/** Three other live actions, for an invite whose action was removed. */
async function alternatives(env: Env, except: string) {
  const r = await env.DB.prepare(`SELECT slug, title, short_answer AS shortAnswer FROM actions WHERE status = 'published' AND cms_item_id != ?1 ORDER BY RANDOM() LIMIT 3`).bind(except).all();
  return r.results;
}

export async function getInvite(env: Env, deps: Deps, code: string, member: Member | null) {
  const inv = await inviteRow(env, code);
  if (!inv) throw new HttpError(404, 'invite_not_found', 'err-invite-not-found');
  const action = await getAction(env, deps, inv.actionId);
  const live = action?.status === 'published';
  let me: Record<string, unknown> | null = null;
  if (member) {
    const j = await env.DB.prepare(`SELECT joined_at, left_at FROM invite_joins WHERE invite_code = ?1 AND member_id = ?2`).bind(code, member.id).first<{ joined_at: string; left_at: string | null }>();
    me = { isMine: member.id === inv.inviterId, joined: !!j && !j.left_at, left: !!j?.left_at };
  }
  return {
    code,
    kind: inv.kind,
    inviterName: inv.inviterDeleted ? null : inv.inviterName,
    note: inv.inviterDeleted ? null : inv.note,
    action: { id: inv.actionId, title: action?.title || '', shortAnswer: action?.short_answer || '', slug: live ? action!.slug : null, live },
    alternatives: live ? [] : await alternatives(env, inv.actionId),
    me,
  };
}

/** Would making `inviterId` the member's inviter create a loop? */
async function wouldLoop(env: Env, memberId: number, inviterId: number): Promise<boolean> {
  let cur: number | null = inviterId;
  for (let i = 0; cur && i < 200; i++) {
    if (cur === memberId) return true;
    const r: { inviter_id: number | null } | null = await env.DB.prepare(`SELECT inviter_id FROM members WHERE id = ?1`).bind(cur).first();
    cur = r?.inviter_id ?? null;
  }
  return false;
}

async function forgetRipple(env: Env, memberId: number): Promise<void> {
  let cur: number | null = memberId;
  for (let i = 0; cur && i < 50; i++) {
    await env.CACHE.delete(`ripple:${cur}`);
    const r: { inviter_id: number | null } | null = await env.DB.prepare(`SELECT inviter_id FROM members WHERE id = ?1`).bind(cur).first();
    cur = r?.inviter_id ?? null;
  }
}

export async function joinInvite(env: Env, deps: Deps, member: Member, code: string) {
  const inv = await inviteRow(env, code);
  if (!inv) throw new HttpError(404, 'invite_not_found', 'err-invite-not-found');
  if (inv.inviterId === member.id) throw new HttpError(409, 'own_invite', 'err-own-invite');
  const action = await getAction(env, deps, inv.actionId);
  if (!action || action.status !== 'published') throw new HttpError(410, 'action_removed', 'err-action-removed');
  const now = iso(deps.now());
  await env.DB.prepare(
    `INSERT INTO invite_joins (invite_code, member_id, joined_at) VALUES (?1, ?2, ?3)
     ON CONFLICT (invite_code, member_id) DO UPDATE SET left_at = NULL, joined_at = CASE WHEN invite_joins.left_at IS NULL THEN invite_joins.joined_at ELSE excluded.joined_at END,
       summarized_at = CASE WHEN invite_joins.left_at IS NULL THEN invite_joins.summarized_at ELSE NULL END`,
  )
    .bind(code, member.id, now)
    .run();
  // One inviter per member: the first invite they accept, and never a loop.
  const fresh = await env.DB.prepare(`SELECT inviter_id FROM members WHERE id = ?1`).bind(member.id).first<{ inviter_id: number | null }>();
  if (!fresh?.inviter_id && !(await wouldLoop(env, member.id, inv.inviterId))) {
    await env.DB.prepare(`UPDATE members SET inviter_id = ?2, inviter_joined_at = ?3 WHERE id = ?1 AND inviter_id IS NULL`).bind(member.id, inv.inviterId, now).run();
    await forgetRipple(env, inv.inviterId);
  }
  return { joined: true, inviterName: inv.inviterName, action: { id: action.cms_item_id, title: action.title, slug: action.slug } };
}

export async function leaveInvite(env: Env, deps: Deps, member: Member, code: string) {
  const inv = await inviteRow(env, code);
  if (!inv) throw new HttpError(404, 'invite_not_found', 'err-invite-not-found');
  const now = iso(deps.now());
  await env.DB.prepare(`UPDATE invite_joins SET left_at = ?3 WHERE invite_code = ?1 AND member_id = ?2 AND left_at IS NULL`).bind(code, member.id, now).run();
  const still = await env.DB.prepare(
    `SELECT 1 AS x FROM invite_joins j JOIN invites i ON i.code = j.invite_code WHERE j.member_id = ?1 AND i.inviter_id = ?2 AND j.left_at IS NULL LIMIT 1`,
  )
    .bind(member.id, inv.inviterId)
    .first();
  if (!still) {
    await env.DB.prepare(`UPDATE members SET inviter_id = NULL, inviter_joined_at = NULL WHERE id = ?1 AND inviter_id = ?2`).bind(member.id, inv.inviterId).run();
    await forgetRipple(env, inv.inviterId);
  }
  return { left: true };
}

/** The account page: who joined my invites, which invites I joined, my ripple. */
export async function memberRipple(env: Env, memberId: number) {
  const joined = await env.DB.prepare(
    `SELECT i.code, i.kind, a.title AS actionTitle, CASE WHEN a.status = 'published' THEN a.slug END AS actionSlug,
       COALESCE(m.share_name, m.first_name) AS name, j.joined_at AS joinedAt
     FROM invites i JOIN invite_joins j ON j.invite_code = i.code JOIN members m ON m.id = j.member_id LEFT JOIN actions a ON a.cms_item_id = i.action_id
     WHERE i.inviter_id = ?1 AND j.left_at IS NULL AND m.deleted_at IS NULL ORDER BY j.joined_at DESC LIMIT 200`,
  )
    .bind(memberId)
    .all();
  const mine = await env.DB.prepare(
    `SELECT i.code, a.title AS actionTitle, CASE WHEN a.status = 'published' THEN a.slug END AS actionSlug,
       COALESCE(m.share_name, m.first_name) AS inviterName, j.joined_at AS joinedAt
     FROM invite_joins j JOIN invites i ON i.code = j.invite_code JOIN members m ON m.id = i.inviter_id LEFT JOIN actions a ON a.cms_item_id = i.action_id
     WHERE j.member_id = ?1 AND j.left_at IS NULL ORDER BY j.joined_at DESC LIMIT 200`,
  )
    .bind(memberId)
    .all();
  return { ripple: await rippleTotal(env, memberId), joinedMyInvites: joined.results, invitesIJoined: mine.results };
}

/** Once a day: one email per inviter naming everyone who joined since the last one. */
export async function inviteSummaries(env: Env, deps: Deps, baseUrl: string) {
  const rows = await env.DB.prepare(
    `SELECT i.inviter_id AS inviterId, j.id AS joinId, COALESCE(m.share_name, m.first_name) AS name, a.title AS title
     FROM invite_joins j JOIN invites i ON i.code = j.invite_code JOIN members m ON m.id = j.member_id LEFT JOIN actions a ON a.cms_item_id = i.action_id
     WHERE j.summarized_at IS NULL AND j.left_at IS NULL ORDER BY i.inviter_id, j.joined_at LIMIT 1000`,
  ).all<{ inviterId: number; joinId: number; name: string | null; title: string | null }>();
  const byInviter = new Map<number, typeof rows.results>();
  for (const r of rows.results) {
    if (!byInviter.has(r.inviterId)) byInviter.set(r.inviterId, []);
    byInviter.get(r.inviterId)!.push(r);
  }
  const now = iso(deps.now());
  const site = baseUrl.replace(/\/join$/, '');
  let sent = 0;
  for (const [inviterId, joins] of byInviter) {
    const stmts = joins.map((j) => env.DB.prepare(`UPDATE invite_joins SET summarized_at = ?2 WHERE id = ?1`).bind(j.joinId, now));
    const inviter = await env.DB.prepare(`SELECT * FROM members WHERE id = ?1 AND deleted_at IS NULL`).bind(inviterId).first<Member>();
    const names = [...new Set(joins.map((j) => j.name || 'Someone'))];
    const titles = [...new Set(joins.map((j) => j.title).filter(Boolean))] as string[];
    const msg = inviter ? await memberEmail(env, inviter, 'invite_summary', { joinedNames: names, actionTitle: titles.length === 1 ? titles[0] : undefined, actionUrl: `${site}/account` }, baseUrl) : null;
    if (msg) {
      stmts.push(enqueue(env, deps, `invite-summary:${inviterId}:${now}`, { op: 'email.send', message: msg }, inviterId));
      sent++;
    }
    await env.DB.batch(stmts);
  }
  return { sent };
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * The link people share: /join/<code>. Answers with a proper preview title
 * and image for Messages, WhatsApp and the rest, then sends the visitor on to
 * the invite page. The link itself carries no name.
 */
export async function invitePreview(env: Env, deps: Deps, code: string, baseUrl: string): Promise<Response> {
  const site = baseUrl.replace(/\/join$/, '');
  const target = `${site}/do-this-with-me?i=${encodeURIComponent(code)}`;
  const inv = await inviteRow(env, code);
  if (!inv) return Response.redirect(`${site}/actions`, 302);
  const action = await getAction(env, deps, inv.actionId).catch(() => null);
  const name = inv.inviterDeleted ? null : inv.inviterName;
  // The same texts as the invite page, plus the preview's own (src/wording/en.json).
  const title =
    action?.status === 'published'
      ? word(inv.kind === 'with_me' ? 'inv-share-with' : 'inv-share-pass', { name: name || word('inv-someone'), title: action.title })
      : word('invite-preview-title');
  const description = (!inv.inviterDeleted && inv.note) || action?.short_answer || word('site-tagline');
  const image = `${baseUrl}/share-invite.png`;
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta property="og:type" content="website">
<meta property="og:site_name" content="${esc(word('site-name'))}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
<meta property="og:url" content="${esc(`${baseUrl}/${code}`)}">
<meta name="twitter:card" content="summary_large_image">
<meta http-equiv="refresh" content="0; url=${esc(target)}">
<link rel="canonical" href="${esc(target)}">
</head><body><p><a href="${esc(target)}">Open the invite</a></p><script>location.replace(${JSON.stringify(target)})</script></body></html>`;
  return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300' } });
}

