// One-time import of done actions and likes from Shopify customer
// metafields (custom.actions_taken, custom.action_votes), which are keyed by
// action slug, into the database keyed by Webflow CMS item ID.

import type { Deps, Env } from '../env';
import { HttpError, iso } from '../http';
import { upsertMember } from '../identity';
import { adminGraphql, customerGid } from '../shopify';
import { syncActions } from './actions';

const FIELDS = `id firstName
  defaultEmailAddress { emailAddress }
  done: metafield(namespace: "custom", key: "actions_taken") { value }
  votes: metafield(namespace: "custom", key: "action_votes") { value }`;

const PAGE_QUERY = `query ($cursor: String) { customers(first: 50, after: $cursor) { pageInfo { hasNextPage endCursor } nodes { ${FIELDS} } } }`;
const ONE_QUERY = `query ($id: ID!) { customer(id: $id) { ${FIELDS} } }`;

interface CustomerNode {
  id: string;
  firstName: string | null;
  defaultEmailAddress: { emailAddress: string | null } | null;
  done: { value: string } | null;
  votes: { value: string } | null;
}

export interface ImportResult {
  customers: number;
  marksAdded: number;
  likesAdded: number;
  unmatched: { customer: string; slug: string; kind: 'done' | 'like' }[];
  invalid: { customer: string; reason: string }[];
  nextCursor: string | null;
}

function parseDate(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value < 1e12 ? value * 1000 : value).toISOString();
  if (typeof value === 'string' && value) {
    const t = Date.parse(value);
    if (Number.isFinite(t)) return new Date(t).toISOString();
  }
  return null;
}

function parseJson(value: string | undefined | null): unknown {
  if (!value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

export async function runImport(env: Env, deps: Deps, opts: { cursor?: string | null; customerId?: string | null }): Promise<ImportResult> {
  // Make sure the slug-to-ID map is current before matching.
  await syncActions(env, deps);
  const actions = await env.DB.prepare(`SELECT cms_item_id, slug, title FROM actions`).all<{ cms_item_id: string; slug: string; title: string }>();
  const bySlug = new Map(actions.results.map((a) => [a.slug, a]));

  let nodes: CustomerNode[];
  let nextCursor: string | null = null;
  if (opts.customerId) {
    const data = await adminGraphql<{ customer: CustomerNode | null }>(env, deps, ONE_QUERY, { id: customerGid(opts.customerId) });
    if (!data.customer) throw new HttpError(404, 'customer_not_found', 'No Shopify customer with that ID.');
    nodes = [data.customer];
  } else {
    const data = await adminGraphql<{ customers: { pageInfo: { hasNextPage: boolean; endCursor: string | null }; nodes: CustomerNode[] } }>(env, deps, PAGE_QUERY, {
      cursor: opts.cursor || null,
    });
    nodes = data.customers.nodes;
    nextCursor = data.customers.pageInfo.hasNextPage ? data.customers.pageInfo.endCursor : null;
  }

  const result: ImportResult = { customers: 0, marksAdded: 0, likesAdded: 0, unmatched: [], invalid: [], nextCursor };
  const now = iso(deps.now());

  for (const c of nodes) {
    const done = parseJson(c.done?.value);
    const votes = parseJson(c.votes?.value);
    if (done === undefined) result.invalid.push({ customer: c.id, reason: 'actions_taken is not valid JSON' });
    if (votes === undefined) result.invalid.push({ customer: c.id, reason: 'action_votes is not valid JSON' });
    const doneList = Array.isArray(done) ? done : [];
    const voteMap = votes && typeof votes === 'object' && !Array.isArray(votes) ? (votes as Record<string, { v?: number; d?: unknown }>) : {};
    if (!doneList.length && !Object.keys(voteMap).length) continue;

    result.customers++;
    const member = await upsertMember(env, deps, {
      id: c.id,
      firstName: c.firstName?.trim() || null,
      email: c.defaultEmailAddress?.emailAddress?.trim().toLowerCase() || null,
    });

    const stmts: D1PreparedStatement[] = [];
    for (const entry of doneList as { idea?: unknown; date?: unknown }[]) {
      const slug = typeof entry?.idea === 'string' ? entry.idea : '';
      const action = bySlug.get(slug);
      if (!action) {
        result.unmatched.push({ customer: c.id, slug: slug || '(missing)', kind: 'done' });
        continue;
      }
      const date = parseDate(entry.date) || now;
      stmts.push(
        env.DB.prepare(
          `INSERT INTO done_marks (member_id, action_id, done_at, action_title, source, import_key) VALUES (?1, ?2, ?3, ?4, 'import', ?5)
           ON CONFLICT (import_key) DO NOTHING`,
        ).bind(member.id, action.cms_item_id, date, action.title, `import:${c.id}:${slug}:${String(entry.date ?? '')}`),
      );
    }
    const doneCount = stmts.length;
    for (const [slug, vote] of Object.entries(voteMap)) {
      const action = bySlug.get(slug);
      const value = Number(vote?.v);
      if (value !== 1 && value !== -1) continue;
      if (!action) {
        result.unmatched.push({ customer: c.id, slug, kind: 'like' });
        continue;
      }
      // Never overwrite a like the member has since set on the new site.
      stmts.push(
        env.DB.prepare(
          `INSERT INTO likes (member_id, action_id, value, updated_at, source) VALUES (?1, ?2, ?3, ?4, 'import') ON CONFLICT (member_id, action_id) DO NOTHING`,
        ).bind(member.id, action.cms_item_id, value, parseDate(vote.d) || now),
      );
    }
    if (stmts.length) {
      const res = await env.DB.batch(stmts);
      res.forEach((r, i) => {
        if (r.meta.changes) i < doneCount ? result.marksAdded++ : result.likesAdded++;
      });
      for (const id of new Set(doneList.map((e) => bySlug.get((e as { idea?: string })?.idea || '')?.cms_item_id).filter(Boolean))) {
        await env.CACHE.delete(`count:${id}`);
      }
    }
  }
  return result;
}
