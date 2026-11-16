// Acceptance checks for Phases 2, 3 and 4 from BRIEF.md, plus the drop
// launch rules added on 16 Nov 2026.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CMS } from '../src/core/config';
import { drain } from '../src/core/queue';
import { stripJpegMetadata, parseVideo } from '../src/core/features/stories';
import { createHarness, SITE, type Harness } from './harness';

let h: Harness;
let actionA: string;
let actionB: string;

const DAY = 24 * 60 * 60 * 1000;

beforeEach(async () => {
  h = await createHarness();
  actionA = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
  actionB = h.fake.addAction('cook-together', 'Cook a meal together', [CMS.actions.onMyOwnCompanionId, '6af7edb79fddcb1ec5b3d86e']);
  h.fake.signIn('shcat_ana', { firstName: 'Ana', email: 'ana@example.com' });
  h.fake.signIn('shcat_ben', { firstName: 'Ben', email: 'ben@example.com' });
});

afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

const tick = () => h.request('POST', '/api/jobs/tick', { origin: null, key: null, headers: { Authorization: 'Bearer jobs_secret' } });
async function flush() {
  await h.settle();
  for (let i = 0; i < 5; i++) await drain(h.env, h.app.deps, { limit: 100 });
}
const done = (token: string, action = actionA) => h.request('POST', `/api/actions/${action}/done`, { token });
const items = (cid: string) => h.fake.collection(cid);

async function shopifyHook(topic: string, payload: unknown, id = crypto.randomUUID()) {
  const body = JSON.stringify(payload);
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode('shopify_webhook_secret'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(body)))));
  return h.app.handle(
    new Request(`${SITE}/join/api/webhooks/shopify`, { method: 'POST', headers: { 'X-Shopify-Hmac-Sha256': sig, 'X-Shopify-Topic': topic, 'X-Shopify-Webhook-Id': id }, body }),
    h.env,
    { waitUntil: () => undefined },
  );
}

function setStatus(cid: string, slug: string, statusId: string) {
  const it = items(cid).find((i) => i.fieldData.slug === slug)!;
  it.fieldData.status = statusId;
  return it;
}

// ---------------------------------------------------------------------------
describe('Phase 2: suggestions', () => {
  it('a sent suggestion appears in the Suggestions collection as "New" within a minute, with close matches noted', async () => {
    await h.request('POST', '/api/admin/sync-actions', { origin: null, key: null, headers: { Authorization: 'Bearer admin_secret' } });
    const res = await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Compliment a stranger on their shoes' } });
    expect(res.status).toBe(201);
    await flush();
    const [item] = items(CMS.suggestions.id);
    expect(item.fieldData).toMatchObject({ status: CMS.suggestions.status.new, 'submitted-by': 'Ana', idea: 'Compliment a stranger on their shoes' });
    expect(String(item.fieldData['review-notes'])).toContain('Action: Compliment a stranger');
  });

  it('"Approved" creates exactly one draft action, even when toggled twice', async () => {
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Leave a note on a parked bike' } });
    await flush();
    setStatus(CMS.suggestions.id, 'suggestion-1', CMS.suggestions.status.approved);
    await tick();
    await flush();
    setStatus(CMS.suggestions.id, 'suggestion-1', CMS.suggestions.status.new);
    h.clock.advance(16 * 60 * 1000);
    await tick();
    setStatus(CMS.suggestions.id, 'suggestion-1', CMS.suggestions.status.approved);
    h.clock.advance(16 * 60 * 1000);
    await tick();
    await flush();
    const drafts = items(CMS.actions.id).filter((i) => i.fieldData.slug === 'suggested-action-1');
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ isDraft: true, live: false });
    expect(drafts[0].fieldData).toMatchObject({ time: 'time5minutes000000000000', cost: 'costfree0000000000000000', 'short-answer': 'Leave a note on a parked bike' });
    const sug = items(CMS.suggestions.id)[0];
    expect(drafts[0].fieldData.suggestion).toBe(sug.id);
    expect(sug.fieldData.action).toBe(drafts[0].id);
  });

  it('publishing that action sends one email and shows "Suggested by"', async () => {
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Leave a note on a parked bike' } });
    await flush();
    const sug = setStatus(CMS.suggestions.id, 'suggestion-1', CMS.suggestions.status.approved);
    await h.request('POST', '/api/webhooks/webflow', { origin: null, key: null, body: { triggerType: 'collection_item_changed', payload: { collectionId: CMS.suggestions.id, id: sug.id } } });
    await flush();
    const draft = items(CMS.actions.id).find((i) => i.fieldData.slug === 'suggested-action-1')!;
    draft.live = true;
    draft.isDraft = false;
    await h.request('POST', '/api/webhooks/webflow', { origin: null, key: null, body: { triggerType: 'collection_item_changed', payload: { collectionId: CMS.actions.id, id: draft.id } } });
    await h.request('POST', '/api/webhooks/webflow', { origin: null, key: null, body: { triggerType: 'collection_item_changed', payload: { collectionId: CMS.actions.id, id: draft.id } } });
    await flush();
    const live = h.fake.emails.filter((e) => e.template?.id === 'hf-suggestion-live');
    expect(live).toHaveLength(1);
    expect(live[0].to).toEqual(['ana@example.com']);
    const st = await (await h.request('GET', `/api/actions/${draft.id}/state`)).json();
    expect(st.suggestedBy).toBe('Ana');
  });

  it('"Rejected" sends nothing, and a deleted draft clears the suggestion\'s link', async () => {
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Idea one' } });
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Idea two' } });
    await flush();
    setStatus(CMS.suggestions.id, 'suggestion-1', CMS.suggestions.status.rejected);
    setStatus(CMS.suggestions.id, 'suggestion-2', CMS.suggestions.status.approved);
    await tick();
    await flush();
    expect(h.fake.emails).toHaveLength(0);
    expect((await h.db('SELECT status FROM suggestions ORDER BY id')).map((r) => r.status)).toEqual(['rejected', 'approved']);
    const draft = items(CMS.actions.id).find((i) => i.fieldData.slug === 'suggested-action-2')!;
    items(CMS.actions.id).splice(items(CMS.actions.id).indexOf(draft), 1);
    await h.request('POST', '/api/webhooks/webflow', { origin: null, key: null, body: { triggerType: 'collection_item_deleted', payload: { collectionId: CMS.actions.id, id: draft.id } } });
    await flush();
    expect(items(CMS.suggestions.id).find((i) => i.fieldData.slug === 'suggestion-2')!.fieldData.action).toBeNull();
    expect((await h.db('SELECT draft_action_id FROM suggestions WHERE id = 2'))[0].draft_action_id).toBeNull();
  });
});

// ---------------------------------------------------------------------------
function jpegWithGps(): Uint8Array {
  const app0 = [0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  const gps = Array.from(new TextEncoder().encode('Exif\0\0GPS 55.6761N 12.5683E'));
  const app1 = [0xff, 0xe1, 0x00, gps.length + 2, ...gps];
  const sos = [0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0x12, 0x34, 0x56];
  return new Uint8Array([0xff, 0xd8, ...app0, ...app1, ...sos, 0xff, 0xd9]);
}

describe('Phase 2: stories', () => {
  const send = (token: string, body: Record<string, unknown>) => h.request('POST', '/api/stories', { token, body: { consent: true, ...body } });

  it('a story cannot be sent for an action the member has not done, even by calling the server directly', async () => {
    const res = await send('shcat_ana', { actionId: actionA, text: 'Made it up' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('not_done');
    expect(await h.db('SELECT * FROM stories')).toHaveLength(0);
  });

  it('needs the consent tick and something to show', async () => {
    await done('shcat_ana');
    expect((await h.request('POST', '/api/stories', { token: 'shcat_ana', body: { actionId: actionA, text: 'Hi' } })).status).toBe(400);
    expect((await (await send('shcat_ana', { actionId: actionA })).json()).error).toBe('empty_story');
  });

  it('an uploaded phone photo has no location data and is served from storage', async () => {
    await done('shcat_ana');
    const raw = jpegWithGps();
    expect(new TextDecoder().decode(raw)).toContain('GPS');
    const up = await h.app.handle(
      new Request(`${SITE}/join/api/stories/photo`, { method: 'POST', headers: { Origin: SITE, Authorization: 'Bearer shcat_ana', 'Content-Type': 'image/jpeg' }, body: raw }),
      h.env,
      { waitUntil: () => undefined },
    );
    expect(up.status).toBe(201);
    const { photoKey } = await up.json();
    const served = await h.app.handle(new Request(`${SITE}/join/media/${photoKey}`), h.env, { waitUntil: () => undefined });
    expect(served.status).toBe(200);
    expect(served.headers.get('Cache-Control')).toContain('immutable');
    const bytes = new Uint8Array(await served.arrayBuffer());
    expect(new TextDecoder().decode(bytes)).not.toContain('GPS');
    expect(bytes[0]).toBe(0xff);
    const res = await send('shcat_ana', { actionId: actionA, photoKey });
    expect(res.status).toBe(201);
    const [s] = await h.db<{ photo_description: string }>('SELECT photo_description FROM stories');
    expect(s.photo_description).toBe("Photo from Ana's story");
  });

  it('refuses files that are not photos, and photos another member uploaded', async () => {
    await done('shcat_ana');
    const bad = await h.app.handle(
      new Request(`${SITE}/join/api/stories/photo`, { method: 'POST', headers: { Origin: SITE, Authorization: 'Bearer shcat_ana', 'Content-Type': 'image/jpeg' }, body: 'not a jpeg' }),
      h.env,
      { waitUntil: () => undefined },
    );
    expect(bad.status).toBe(415);
    expect(stripJpegMetadata(new Uint8Array([1, 2, 3]))).toBeNull();
    expect((await send('shcat_ana', { actionId: actionA, photoKey: 'stories/someoneelsesphotokey123.jpg' })).status).toBe(400);
  });

  it('a TikTok or Shorts link shows as a vertical, muted player', async () => {
    expect(parseVideo('https://www.tiktok.com/@ana/video/7312345678901234567')).toMatchObject({ provider: 'tiktok', vertical: true });
    expect(parseVideo('https://www.tiktok.com/@ana/video/7312345678901234567')!.embed).toContain('muted=1');
    expect(parseVideo('https://youtube.com/shorts/abcdefghijk')).toMatchObject({ provider: 'youtube', vertical: true, embed: expect.stringContaining('mute=1') });
    expect(parseVideo('https://vimeo.com/123456789')).toMatchObject({ vertical: false });
    expect(parseVideo('https://example.com/video.mp4')).toBeNull();
    await done('shcat_ana');
    expect((await send('shcat_ana', { actionId: actionA, videoUrl: 'https://example.com/x' })).status).toBe(400);
    expect((await send('shcat_ana', { actionId: actionA, videoUrl: 'https://youtube.com/shorts/abcdefghijk' })).status).toBe(201);
  });

  it('"Approved" publishes the story on /stories and the action page and emails once; editing takes it down again', async () => {
    await done('shcat_ana');
    await send('shcat_ana', { actionId: actionA, text: 'She smiled all day.' });
    await flush();
    expect((await (await h.request('GET', '/api/stories')).json()).stories).toHaveLength(0);
    const item = setStatus(CMS.stories.id, 'story-1', CMS.stories.status.approved);
    await tick();
    await flush();
    expect(item.live).toBe(true);
    expect((await (await h.request('GET', '/api/stories')).json()).stories).toHaveLength(1);
    expect((await (await h.request('GET', `/api/actions/${actionA}/state`)).json()).stories[0]).toMatchObject({ name: 'Ana', text: 'She smiled all day.' });
    expect(h.fake.emails.filter((e) => e.template?.id?.startsWith('hf-story-live'))).toHaveLength(1);
    h.clock.advance(16 * 60 * 1000);
    await tick();
    await flush();
    expect(h.fake.emails.filter((e) => e.template?.id?.startsWith('hf-story-live'))).toHaveLength(1);

    const edit = await send('shcat_ana', { actionId: actionA, text: 'She smiled all week.' });
    expect((await edit.json()).edited).toBe(true);
    await flush();
    expect(item.live).toBe(false);
    expect(item.fieldData.status).toBe(CMS.stories.status.new);
    expect((await (await h.request('GET', '/api/stories')).json()).stories).toHaveLength(0);
  });

  it('only people who joined the member\'s invite can be on the "with" line', async () => {
    await done('shcat_ana', actionB);
    expect((await send('shcat_ana', { actionId: actionB, text: 'Fun', withMemberIds: [2] })).status).toBe(400);
    const inv = await (await h.request('POST', '/api/invites', { token: 'shcat_ana', body: { actionId: actionB, kind: 'with_me' } })).json();
    await h.request('POST', `/api/invites/${inv.code}/join`, { token: 'shcat_ben' });
    const mine = await (await h.request('GET', `/api/stories/mine?action=${actionB}`, { token: 'shcat_ana' })).json();
    expect(mine.withCandidates).toEqual([{ id: 2, name: 'Ben' }]);
    expect((await send('shcat_ana', { actionId: actionB, text: 'Fun', withMemberIds: [2] })).status).toBe(201);
  });

  it('"Report this story" emails Mickey, behind the bot check', async () => {
    await done('shcat_ana');
    await send('shcat_ana', { actionId: actionA, text: 'Hello' });
    await h.db(`UPDATE stories SET status = 'approved'`);
    expect((await h.request('POST', '/api/stories/1/report', { body: {} })).status).toBe(403);
    const ok = await h.request('POST', '/api/stories/1/report', { body: { reason: 'Not kind', turnstileToken: 'human-token' } });
    expect(ok.status).toBe(200);
    await flush();
    expect(h.fake.emails.filter((e) => e.subject.startsWith('A story was reported'))).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
describe('Phase 3: counts', () => {
  it('an action with 9 marks shows no count; the tenth person makes it appear', async () => {
    for (let i = 0; i < 9; i++) {
      h.fake.signIn(`shcat_p${i}`);
      await done(`shcat_p${i}`);
    }
    expect((await (await h.request('GET', `/api/actions/${actionA}/state`)).json()).count).toBeNull();
    h.fake.signIn('shcat_p9');
    expect((await (await done('shcat_p9')).json()).count).toBe(10);
    expect((await (await h.request('GET', `/api/actions/${actionA}/state`)).json()).count).toBe(10);
  });

  it('"I did this again" has no limit: every click counts toward the tally, the public count counts people once', async () => {
    for (let i = 1; i <= 15; i++) expect((await (await done('shcat_ana')).json()).tally).toBe(i);
    const st = await (await h.request('GET', `/api/actions/${actionA}/state`, { token: 'shcat_ana' })).json();
    expect(st.me).toMatchObject({ timesDone: 15, tally: 15 });
    expect(await h.db(`SELECT COUNT(DISTINCT member_id) AS n FROM done_marks`)).toEqual([{ n: 1 }]);
  });

  it('undo lowers the tally and the count, and is refused when a story is attached', async () => {
    for (let i = 0; i < 10; i++) {
      h.fake.signIn(`shcat_p${i}`);
      await done(`shcat_p${i}`);
    }
    const undo = await h.request('DELETE', `/api/actions/${actionA}/done`, { token: 'shcat_p0' });
    expect(undo.status).toBe(200);
    expect(await undo.json()).toMatchObject({ done: false, tally: 0, count: null });
    await done('shcat_p0');
    await h.request('POST', '/api/stories', { token: 'shcat_p0', body: { actionId: actionA, text: 'Yes', consent: true } });
    const refused = await h.request('DELETE', `/api/actions/${actionA}/done`, { token: 'shcat_p0' });
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('story_attached');
  });

  it('writes the public count and likes to the CMS once a day, only when they change', async () => {
    for (let i = 0; i < 10; i++) {
      h.fake.signIn(`shcat_p${i}`);
      await done(`shcat_p${i}`);
    }
    await h.request('PUT', `/api/actions/${actionB}/like`, { token: 'shcat_ana', body: { liked: true } });
    const first = await (await tick()).json();
    expect(first.writeCounts.changed).toBe(2);
    await flush();
    const a = items(CMS.actions.id).find((i) => i.id === actionA)!;
    const b = items(CMS.actions.id).find((i) => i.id === actionB)!;
    expect(a.fieldData).toMatchObject({ 'done-count': 10, votes: 0 });
    expect(b.fieldData).toMatchObject({ 'done-count': 0, votes: 1 });
    h.clock.advance(61 * 60 * 1000); // hourly
    expect((await (await tick()).json()).writeCounts.changed).toBe(0);
    h.fake.signIn('shcat_p10');
    await done('shcat_p10');
    h.clock.advance(61 * 60 * 1000);
    expect((await (await tick()).json()).writeCounts.changed).toBe(1);
  });

  it('"Most done" stays hidden until 5 actions reach 10 people', async () => {
    const ids = [actionA, actionB, ...[1, 2, 3].map((n) => h.fake.addAction(`a-${n}`, `Action ${n}`))];
    for (let p = 0; p < 10; p++) {
      h.fake.signIn(`shcat_p${p}`);
      for (const id of ids.slice(0, 4)) await done(`shcat_p${p}`, id);
    }
    expect((await (await h.request('GET', '/api/most-done')).json()).actions).toEqual([]);
    for (let p = 0; p < 10; p++) await done(`shcat_p${p}`, ids[4]);
    const list = (await (await h.request('GET', '/api/most-done')).json()).actions;
    expect(list).toHaveLength(5);
    expect(list[0]).toMatchObject({ people: 10 });
  });
});

// ---------------------------------------------------------------------------
const PRODUCT = 'gid://shopify/Product/555';
const OTHER = 'gid://shopify/Product/777';

async function setupDrop(opts: { dropDate?: string; quantity?: number } = {}) {
  const leadItem = h.fake.newId();
  h.fake.collection(CMS.products.id).push({ id: leadItem, isDraft: false, live: true, fieldData: { name: 'Tee', slug: 'tee', 'shopify-id': PRODUCT } });
  await h.db(`INSERT INTO product_sync (shopify_id, cms_item_id, source_hash, state, synced_at) VALUES (?1, ?2, 'x', 'live', '2026-11-16')`, PRODUCT, leadItem);
  const drop = {
    id: h.fake.newId(),
    isDraft: false,
    live: true,
    fieldData: {
      name: 'Drop 01',
      slug: 'drop-01',
      status: CMS.drops.status.upcoming,
      'show-on-front-page': true,
      'drop-date': opts.dropDate ?? '2026-12-05T17:00:00.000Z',
      quantity: opts.quantity ?? 100,
      'details-line': 'typed by hand',
      'lead-product': leadItem,
      'products-in-this-drop': [leadItem],
    } as Record<string, unknown>,
  };
  h.fake.collection(CMS.drops.id).push(drop);
  return drop;
}

function orderPayload(id: number, opts: { email?: string; customerId?: number | null; qty?: number; product?: number; at?: string; refunds?: unknown[]; cancelled?: boolean } = {}) {
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    email: opts.email ?? 'ana@example.com',
    created_at: opts.at ?? '2026-11-16T10:00:00Z',
    processed_at: opts.at ?? '2026-11-16T10:00:00Z',
    cancelled_at: opts.cancelled ? '2026-11-17T00:00:00Z' : null,
    customer: opts.customerId === null ? null : { id: opts.customerId ?? 1000 },
    line_items: [{ id: id * 10, admin_graphql_api_id: `gid://shopify/LineItem/${id * 10}`, product_id: opts.product ?? 555, quantity: opts.qty ?? 1 }],
    refunds: opts.refunds ?? [],
  };
}

describe('Phase 3: pledges', () => {
  beforeEach(async () => {
    await setupDrop();
    // Ana becomes a member (Shopify customer 1000).
    await h.request('GET', '/api/me', { token: 'shcat_ana' });
  });

  it('a test order of two pieces makes two pledges; refunding one removes one', async () => {
    expect((await shopifyHook('orders/create', orderPayload(1, { qty: 2 }))).status).toBe(200);
    expect(await h.db(`SELECT piece, status, drop_id FROM pledges ORDER BY piece`)).toEqual([
      { piece: 1, status: 'open', drop_id: 'drop-01' },
      { piece: 2, status: 'open', drop_id: 'drop-01' },
    ]);
    h.fake.orders.push({
      id: 'gid://shopify/Order/1',
      email: 'ana@example.com',
      createdAt: '2026-11-16T10:00:00Z',
      processedAt: '2026-11-16T10:00:00Z',
      cancelledAt: null,
      customer: { id: 'gid://shopify/Customer/1000' },
      lineItems: { nodes: [{ id: 'gid://shopify/LineItem/10', quantity: 2, product: { id: PRODUCT } }] },
      refunds: [{ refundLineItems: { nodes: [{ quantity: 1, lineItem: { id: 'gid://shopify/LineItem/10' } }] } }],
    });
    await shopifyHook('refunds/create', { order_id: 1, refund_line_items: [{ line_item_id: 10, quantity: 1 }] });
    expect(await h.db(`SELECT piece, status FROM pledges ORDER BY piece`)).toEqual([
      { piece: 1, status: 'open' },
      { piece: 2, status: 'cancelled' },
    ]);
    // The same webhook again changes nothing.
    await shopifyHook('orders/create', orderPayload(1, { qty: 2 }));
    expect(await h.db(`SELECT COUNT(*) AS n FROM pledges`)).toEqual([{ n: 2 }]);
    const st = await (await h.request('GET', '/api/drops/state?drop=drop-01')).json();
    expect(st.pledges).toEqual({ made: 1, kept: 0 });
  });

  it('a cancelled order removes its pledges', async () => {
    await shopifyHook('orders/create', orderPayload(1, { qty: 2 }));
    await shopifyHook('orders/cancelled', orderPayload(1, { qty: 2, cancelled: true }));
    expect(await h.db(`SELECT status FROM pledges`)).toEqual([{ status: 'cancelled' }, { status: 'cancelled' }]);
  });

  it('an action done after the order keeps the oldest open pledge; one done before does not', async () => {
    await done('shcat_ana'); // 09:00, before the order
    await shopifyHook('orders/create', orderPayload(1, { at: '2026-11-16T09:30:00Z' }));
    await shopifyHook('orders/create', orderPayload(2, { at: '2026-11-16T09:45:00Z' }));
    expect(await h.db(`SELECT shopify_order_id AS o, status FROM pledges ORDER BY id`)).toEqual([
      { o: 'gid://shopify/Order/1', status: 'open' },
      { o: 'gid://shopify/Order/2', status: 'open' },
    ]);
    h.clock.advance(DAY);
    await done('shcat_ana', actionB);
    expect(await h.db(`SELECT shopify_order_id AS o, status FROM pledges ORDER BY id`)).toEqual([
      { o: 'gid://shopify/Order/1', status: 'kept' },
      { o: 'gid://shopify/Order/2', status: 'open' },
    ]);
    const me = await (await h.request('GET', '/api/me', { token: 'shcat_ana' })).json();
    expect(me.pledges.find((p: { status: string }) => p.status === 'kept')).toMatchObject({ keptByTitle: 'Cook a meal together', keptBySlug: 'cook-together' });
    expect((await (await h.request('GET', '/api/drops/state')).json()).pledges).toEqual({ made: 2, kept: 1 });
    // Undo reopens it.
    await h.request('DELETE', `/api/actions/${actionB}/done`, { token: 'shcat_ana' });
    expect(await h.db(`SELECT status FROM pledges WHERE status = 'kept'`)).toEqual([]);
  });

  it('an order placed without an account links to the member when that email signs in', async () => {
    await shopifyHook('orders/create', orderPayload(5, { email: 'cleo@example.com', customerId: null }));
    expect(await h.db(`SELECT member_id, buyer_email FROM pledges`)).toEqual([{ member_id: null, buyer_email: 'cleo@example.com' }]);
    h.fake.signIn('shcat_cleo', { firstName: 'Cleo', email: 'cleo@example.com' });
    h.clock.advance(2 * 60 * 60 * 1000);
    await done('shcat_cleo');
    const [p] = await h.db<{ member_id: number; buyer_email: string | null; status: string }>(`SELECT member_id, buyer_email, status FROM pledges`);
    expect(p.member_id).toBeGreaterThan(0);
    expect(p.buyer_email).toBeNull();
    expect(p.status).toBe('kept');
  });

  it('the reminder is sent once at 7 days and never again', async () => {
    await shopifyHook('orders/create', orderPayload(1, { qty: 2 }));
    h.clock.advance(6 * DAY);
    await tick();
    await flush();
    expect(h.fake.emails.filter((e) => e.template?.id === 'hf-pledge-reminder')).toHaveLength(0);
    h.clock.advance(DAY + 2 * 60 * 60 * 1000);
    await tick();
    await flush();
    h.clock.advance(2 * 60 * 60 * 1000);
    await tick();
    await flush();
    h.clock.advance(10 * DAY);
    await tick();
    await flush();
    expect(h.fake.emails.filter((e) => e.template?.id === 'hf-pledge-reminder')).toHaveLength(1);
  });

  it('the timer picks up orders that a webhook missed', async () => {
    h.fake.orders.push({
      id: 'gid://shopify/Order/9',
      email: 'ana@example.com',
      createdAt: '2026-11-16T08:00:00Z',
      processedAt: '2026-11-16T08:00:00Z',
      cancelledAt: null,
      customer: { id: 'gid://shopify/Customer/1000' },
      lineItems: { nodes: [{ id: 'gid://shopify/LineItem/90', quantity: 3, product: { id: PRODUCT } }] },
      refunds: [],
    });
    const out = await (await tick()).json();
    expect(out.syncOrders).toEqual({ orders: 1 });
    expect(await h.db(`SELECT COUNT(*) AS n FROM pledges WHERE drop_id = 'drop-01'`)).toEqual([{ n: 3 }]);
  });
});

describe('Phase 3: stock and drop state', () => {
  it('"X of 100 left" matches Shopify within 60 seconds and switches to sold out at zero', async () => {
    await setupDrop({ dropDate: '2026-11-15T17:00:00.000Z' });
    h.fake.inventory.set(PRODUCT, 64);
    const a = await (await h.request('GET', '/api/drops/state')).json();
    expect(a).toMatchObject({ status: 'live', left: 64, quantity: 100 });
    h.fake.inventory.set(PRODUCT, 0);
    expect((await (await h.request('GET', '/api/drops/state')).json()).left).toBe(64); // cached
    h.clock.advance(61 * 1000);
    await h.env.CACHE.delete('drop-stock:drop-01'); // Miniflare does not expire KV on the fake clock
    const b = await (await h.request('GET', '/api/drops/state')).json();
    expect(b).toMatchObject({ status: 'sold_out', left: 0, detailsLine: '100 pieces. All gone. Thank you.' });
  });

  it('lists the current drop and past drops for the shop, each with its collection', async () => {
    await setupDrop({ dropDate: '2026-11-15T17:00:00.000Z' });
    h.fake.inventory.set(PRODUCT, 0);
    h.fake.collection(CMS.drops.id).push({
      id: h.fake.newId(),
      isDraft: false,
      live: true,
      fieldData: { name: 'Drop 02', slug: 'drop-02', statement: 'Be the reason.', 'drop-date': '2026-12-20T17:00:00.000Z', quantity: 50 },
    });
    const shop = await (await h.request('GET', '/api/drops')).json();
    expect(shop.current).toMatchObject({ drop: 'drop-02', status: 'upcoming', collection: 'drop-02', statement: 'Be the reason.' });
    expect(shop.past).toEqual([expect.objectContaining({ drop: 'drop-01', status: 'sold_out', collection: 'drop-01' })]);
  });

  it('labels products truthfully: drop pieces with the drop, limited editions with their size, the rest with nothing', async () => {
    await setupDrop({ dropDate: '2026-12-05T17:00:00.000Z' });
    const base = { status: 'ACTIVE' as const, descriptionHtml: '', description: '' };
    h.fake.products.push({ ...base, id: PRODUCT, handle: 'tee', title: 'Tee' });
    h.fake.products.push({ ...base, id: 'gid://shopify/Product/801', handle: 'print', title: 'Print', editionSize: 250 });
    h.fake.products.push({ ...base, id: 'gid://shopify/Product/802', handle: 'mug', title: 'Mug' });
    h.fake.inventory.set('gid://shopify/Product/801', 12);
    const { labels } = await (await h.request('GET', '/api/products/labels')).json();
    expect(labels).toEqual({ tee: { name: 'Drop 01', size: 100, left: null, soldOut: false }, print: { name: null, size: 250, left: 12, soldOut: false } });
  });

  it('answers the whole shop in one call, leaving out empty sections', async () => {
    await setupDrop({ dropDate: '2026-12-05T17:00:00.000Z' });
    h.fake.products.push({ id: PRODUCT, handle: 'tee', title: 'Tee', status: 'ACTIVE', descriptionHtml: '', description: '' });
    h.fake.shopCollections.set('drop-01', [PRODUCT]);
    const shop = await (await h.request('GET', '/api/shop')).json();
    expect(shop.current).toMatchObject({ drop: 'drop-01', status: 'upcoming', products: [{ handle: 'tee', title: 'Tee', available: true, label: { name: 'Drop 01', size: 100, left: null, soldOut: false } }] });
    expect(shop.availableNow).toEqual([]);
    expect(shop.past).toEqual([]);
    // Later visits get the stored copy at once, even when it is older than a minute.
    h.fake.products[0].title = 'Tee, renamed';
    h.clock.advance(5 * 60 * 1000);
    const stale = await (await h.request('GET', '/api/shop')).json();
    expect(stale.current.products[0].title).toBe('Tee');
    await h.settle(); // the background refresh
    const fresh = await (await h.request('GET', '/api/shop')).json();
    expect(fresh.current.products[0].title).toBe('Tee, renamed');
  });

  it('adds up every piece of a drop: total pieces, pieces left, and sold out only when all are gone', async () => {
    const drop = await setupDrop({ dropDate: '2026-11-15T17:00:00.000Z' });
    const MUG = 'gid://shopify/Product/803';
    const mugItem = h.fake.newId();
    await h.db(`INSERT INTO product_sync (shopify_id, cms_item_id, source_hash, state, synced_at) VALUES (?1, ?2, 'x', 'live', '2026-11-16')`, MUG, mugItem);
    drop.fieldData['products-in-this-drop'] = [drop.fieldData['lead-product'], mugItem];
    const base = { status: 'ACTIVE' as const, descriptionHtml: '', description: '' };
    h.fake.products.push({ ...base, id: PRODUCT, handle: 'tee', title: 'Tee', editionSize: 100 });
    h.fake.products.push({ ...base, id: MUG, handle: 'mug', title: 'Mug', editionSize: 100 });
    h.fake.inventory.set(PRODUCT, 0);
    h.fake.inventory.set(MUG, 40);
    const a = await (await h.request('GET', '/api/drops/state')).json();
    expect(a).toMatchObject({ status: 'live', quantity: 200, left: 40, detailsLine: "200 pieces. Out now. Gone when they're gone." });
    const { labels } = await (await h.request('GET', '/api/products/labels')).json();
    expect(labels).toEqual({ tee: { name: 'Drop 01', size: 100, left: null, soldOut: true }, mug: { name: 'Drop 01', size: 100, left: 40, soldOut: false } });
    h.fake.inventory.set(MUG, 0);
    await h.env.CACHE.delete('drop-stock:drop-01');
    expect(await (await h.request('GET', '/api/drops/state')).json()).toMatchObject({ status: 'sold_out', quantity: 200, left: 0 });
  });

  it("uses the drop's Quantity when a piece has no edition size", async () => {
    await setupDrop({ dropDate: '2026-12-05T17:00:00.000Z' });
    h.fake.products.push({ status: 'ACTIVE', descriptionHtml: '', description: '', id: PRODUCT, handle: 'tee', title: 'Tee' });
    h.fake.inventory.set(PRODUCT, 100);
    expect(await (await h.request('GET', '/api/drops/state')).json()).toMatchObject({ status: 'upcoming', quantity: 100 });
  });

  it('hides the line when inventory is not tracked', async () => {
    await setupDrop({ dropDate: '2026-11-15T17:00:00.000Z' });
    h.fake.inventory.set(PRODUCT, null);
    expect(await (await h.request('GET', '/api/drops/state')).json()).toMatchObject({ status: 'live', left: null });
  });

  it('keeps Status and the details line in the CMS in step with the date, and refuses sign-ups once live', async () => {
    const drop = await setupDrop({ dropDate: '2026-11-16T12:00:00.000Z' });
    h.fake.inventory.set(PRODUCT, 100);
    await tick();
    expect(drop.fieldData['details-line']).toBe("100 pieces. Drops November 16 at 07:00 ET. Gone when they're gone.");
    expect(drop.fieldData.status).toBe(CMS.drops.status.upcoming);
    h.clock.advance(4 * 60 * 60 * 1000);
    await tick();
    expect(drop.fieldData.status).toBe(CMS.drops.status.live);
    expect(drop.fieldData['details-line']).toBe("100 pieces. Out now. Gone when they're gone.");
    const late = await h.request('POST', '/api/drops/notify', { token: 'shcat_ana', body: { drop: 'drop-01' } });
    expect(late.status).toBe(409);
  });

  it('holds drop products back in Shopify until the drop date, once', async () => {
    await setupDrop({ dropDate: '2026-12-05T17:00:00.000Z' });
    const out = await (await tick()).json();
    expect(out.dropReleases.scheduled).toEqual([PRODUCT]);
    // Only the channel it was on; never a channel it was not on.
    expect(h.fake.published.get(PRODUCT)).toEqual({ 'gid://shopify/Publication/1': '2026-12-05T17:00:00.000Z' });
    h.clock.advance(61 * 60 * 1000);
    expect((await (await tick()).json()).dropReleases.scheduled).toEqual([]);
  });

  it('says plainly when the Shopify app lacks the publishing permission', async () => {
    await setupDrop();
    h.fake.publicationsAllowed = false;
    const out = await (await tick()).json();
    expect(out.dropReleases).toEqual({ scheduled: [], needsScopes: ['read_publications', 'write_publications'] });
    expect(h.fake.published.size).toBe(0);
    // Other products are untouched.
    expect(h.fake.published.has(OTHER)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('Phase 4: ripple', () => {
  const invite = async (token: string, actionId = actionB, kind = 'with_me') => (await h.request('POST', '/api/invites', { token, body: { actionId, kind } })).json();

  it('the share link contains a code and no name', async () => {
    const inv = await invite('shcat_ana');
    expect(inv.url).toMatch(new RegExp(`^${SITE}/join/[A-Za-z0-9]{10}$`));
    expect(inv.url).not.toContain('Ana');
    expect(inv.text).toBe('Ana wants to do this with you: Cook a meal together');
    // Asking again gives the same link.
    expect((await invite('shcat_ana')).code).toBe(inv.code);
  });

  it('carries a short note from the inviter to the invite page and the link preview', async () => {
    const res = await (await h.request('POST', '/api/invites', { token: 'shcat_ana', body: { actionId: actionB, kind: 'with_me', note: '  Saturday at mine?  ' } })).json();
    expect(res.text).toBe('Saturday at mine?\n\nAna wants to do this with you: Cook a meal together');
    expect((await (await h.request('GET', `/api/invites/${res.code}`)).json()).note).toBe('Saturday at mine?');
    expect(await (await h.request('GET', `/${res.code}`, { origin: null })).text()).toContain('<meta property="og:description" content="Saturday at mine?">');
    // A later share with a new note replaces it; the link stays the same.
    const again = await (await h.request('POST', '/api/invites', { token: 'shcat_ana', body: { actionId: actionB, kind: 'with_me', note: 'Sunday instead?' } })).json();
    expect(again.code).toBe(res.code);
    expect((await (await h.request('GET', `/api/invites/${res.code}`)).json()).note).toBe('Sunday instead?');
    const long = await (await h.request('POST', '/api/invites', { token: 'shcat_ana', body: { actionId: actionB, kind: 'with_me', note: 'x'.repeat(400) } })).json();
    expect(long.note).toHaveLength(280);
  });

  it('asks for a first name before the first share', async () => {
    h.fake.signIn('shcat_noname', { firstName: null });
    const res = await h.request('POST', '/api/invites', { token: 'shcat_noname', body: { actionId: actionB, kind: 'with_me' } });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('need_first_name');
    await h.request('PATCH', '/api/me/settings', { token: 'shcat_noname', body: { firstName: 'Dee' } });
    expect((await invite('shcat_noname')).text).toMatch(/^Dee wants/);
  });

  it('a new person taps "I\'m in", signs up and lands on the invited action', async () => {
    const inv = await invite('shcat_ana');
    const intent = await (await h.request('POST', '/api/intents', { body: { kind: 'join', inviteCode: inv.code, returnTo: '/do-this-with-me?i=' + inv.code, turnstileToken: 'human-token' } })).json();
    h.fake.signIn('shcat_new', { firstName: 'Nia' });
    const res = await (await h.request('POST', `/api/intents/${intent.id}/complete`, { token: 'shcat_new', key: null })).json();
    expect(res).toMatchObject({ kind: 'join', completed: true, returnTo: `/do-this-with-me?i=${inv.code}` });
    expect(res.result.action).toMatchObject({ slug: 'cook-together' });
    const page = await (await h.request('GET', `/api/invites/${inv.code}`, { token: 'shcat_new' })).json();
    expect(page).toMatchObject({ inviterName: 'Ana', me: { joined: true, isMine: false }, action: { live: true, slug: 'cook-together' } });
  });

  it("the inviter's account shows the joiner's first name, and opening your own invite says so", async () => {
    const inv = await invite('shcat_ana');
    await h.request('POST', `/api/invites/${inv.code}/join`, { token: 'shcat_ben' });
    const me = await (await h.request('GET', '/api/me', { token: 'shcat_ana' })).json();
    expect(me.joinedMyInvites).toEqual([expect.objectContaining({ name: 'Ben', actionTitle: 'Cook a meal together' })]);
    const own = await h.request('POST', `/api/invites/${inv.code}/join`, { token: 'shcat_ana' });
    expect((await own.json()).error).toBe('own_invite');
    expect((await (await h.request('GET', `/api/invites/${inv.code}`, { token: 'shcat_ana' })).json()).me.isMine).toBe(true);
  });

  it('twenty joins in a day produce one email', async () => {
    const inv = await invite('shcat_ana');
    for (let i = 0; i < 20; i++) {
      h.fake.signIn(`shcat_j${i}`, { firstName: `J${i}` });
      await h.request('POST', `/api/invites/${inv.code}/join`, { token: `shcat_j${i}` });
    }
    await tick();
    await flush();
    const mails = h.fake.emails.filter((e) => e.template?.id?.startsWith('hf-invite-joined'));
    expect(mails).toHaveLength(1);
    expect(mails[0].template).toMatchObject({ id: 'hf-invite-joined-many', variables: { COUNT: 20 } });
    await tick();
    await flush();
    expect(h.fake.emails.filter((e) => e.template?.id?.startsWith('hf-invite-joined'))).toHaveLength(1);
  });

  it('A invites B and B invites A: totals are counted once', async () => {
    const a = await invite('shcat_ana');
    await h.request('POST', `/api/invites/${a.code}/join`, { token: 'shcat_ben' });
    await done('shcat_ben', actionB);
    const b = await invite('shcat_ben', actionB);
    await h.request('POST', `/api/invites/${b.code}/join`, { token: 'shcat_ana' });
    await h.env.CACHE.delete('ripple:1');
    await h.env.CACHE.delete('ripple:2');
    expect((await h.db(`SELECT id, inviter_id FROM members ORDER BY id`))).toEqual([
      { id: 1, inviter_id: null },
      { id: 2, inviter_id: 1 },
    ]);
    h.clock.advance(DAY);
    await done('shcat_ana', actionB);
    await h.env.CACHE.delete('ripple:1');
    await h.env.CACHE.delete('ripple:2');
    const ana = await (await h.request('GET', '/api/me', { token: 'shcat_ana' })).json();
    const ben = await (await h.request('GET', '/api/me', { token: 'shcat_ben' })).json();
    expect(ana.ripple).toBe(1); // Ben's mark after joining
    expect(ben.ripple).toBe(0); // Ana is above Ben, never below
  });

  it('joining without doing adds nothing; a joiner can leave', async () => {
    const inv = await invite('shcat_ana');
    await h.request('POST', `/api/invites/${inv.code}/join`, { token: 'shcat_ben' });
    expect((await (await h.request('GET', '/api/me', { token: 'shcat_ana' })).json()).ripple).toBe(0);
    await h.request('DELETE', `/api/invites/${inv.code}/join`, { token: 'shcat_ben' });
    const me = await (await h.request('GET', '/api/me', { token: 'shcat_ana' })).json();
    expect(me.joinedMyInvites).toEqual([]);
    expect(await h.db(`SELECT inviter_id FROM members WHERE id = 2`)).toEqual([{ inviter_id: null }]);
  });

  it('"Done together with" shows on the action for both sides', async () => {
    const inv = await invite('shcat_ana');
    await h.request('POST', `/api/invites/${inv.code}/join`, { token: 'shcat_ben' });
    await done('shcat_ana', actionB);
    await done('shcat_ben', actionB);
    expect((await (await h.request('GET', `/api/actions/${actionB}/state`, { token: 'shcat_ana' })).json()).me.doneWith).toEqual(['Ben']);
    expect((await (await h.request('GET', `/api/actions/${actionB}/state`, { token: 'shcat_ben' })).json()).me.doneWith).toEqual(['Ana']);
  });

  it('the invite link shows a proper title and image when pasted into a message', async () => {
    const inv = await invite('shcat_ana');
    const res = await h.request('GET', `/${inv.code}`, { origin: null });
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<meta property="og:title" content="Ana wants to do this with you: Cook a meal together">');
    expect(html).toContain(`<meta property="og:image" content="${SITE}/join/share-invite.png">`);
    expect(html).toContain(`${SITE}/do-this-with-me?i=${inv.code}`);
    expect((await h.request('GET', '/not-a-code!', { origin: null })).status).toBe(404);
  });

  it('an invite to a removed action shows the "no longer available" page with three suggestions', async () => {
    [1, 2, 3, 4].forEach((n) => h.fake.addAction(`other-${n}`, `Other ${n}`));
    await h.request('POST', '/api/admin/sync-actions', { origin: null, key: null, headers: { Authorization: 'Bearer admin_secret' } });
    const inv = await invite('shcat_ana');
    items(CMS.actions.id).find((i) => i.id === actionB)!.live = false;
    h.clock.advance(1000);
    await h.request('POST', '/api/admin/sync-actions', { origin: null, key: null, headers: { Authorization: 'Bearer admin_secret' } });
    const page = await (await h.request('GET', `/api/invites/${inv.code}`)).json();
    expect(page.action.live).toBe(false);
    expect(page.alternatives).toHaveLength(3);
    const join = await h.request('POST', `/api/invites/${inv.code}/join`, { token: 'shcat_ben' });
    expect(join.status).toBe(410);
  });

  it('"Pass it on" needs the action done first', async () => {
    const res = await h.request('POST', '/api/invites', { token: 'shcat_ana', body: { actionId: actionA, kind: 'pass_it_on' } });
    expect(res.status).toBe(403);
    await done('shcat_ana');
    expect((await invite('shcat_ana', actionA, 'pass_it_on')).text).toBe('Ana did this and is passing it on: Compliment a stranger');
  });
});

describe('Reviewing from /lab', () => {
  const lab = (token: string) => ({ token, body: undefined as unknown });
  it('anyone with Lab access can approve or reject; the CMS follows and the usual emails go out', async () => {
    h.env.LAB_EMAILS = 'boss@example.com';
    h.fake.signIn('shcat_boss', { email: 'boss@example.com', firstName: 'Boss' });
    await done('shcat_ana');
    await h.request('POST', '/api/stories', { token: 'shcat_ana', body: { actionId: actionA, text: 'Lovely day', consent: true } });
    await h.request('POST', '/api/suggestions', { token: 'shcat_ana', body: { text: 'Leave a note on a bike' } });
    expect((await h.request('GET', '/api/lab/review', lab('shcat_ana'))).status).toBe(403);
    await flush();
    const q = await (await h.request('GET', '/api/lab/review', lab('shcat_boss'))).json();
    expect(q.stories).toEqual([expect.objectContaining({ id: 1, text: 'Lovely day', name: 'Ana', actionTitle: 'Compliment a stranger' })]);
    expect(q.suggestions).toEqual([expect.objectContaining({ id: 1, text: 'Leave a note on a bike' })]);
    expect((await h.request('POST', '/api/lab/review', { token: 'shcat_boss', body: { type: 'story', id: 1, decision: 'approved' } })).status).toBe(200);
    expect((await h.request('POST', '/api/lab/review', { token: 'shcat_boss', body: { type: 'suggestion', id: 1, decision: 'rejected' } })).status).toBe(200);
    await flush();
    const story = items(CMS.stories.id)[0];
    expect(story.fieldData.status).toBe(CMS.stories.status.approved);
    expect(story.live).toBe(true);
    expect(items(CMS.suggestions.id)[0].fieldData.status).toBe(CMS.suggestions.status.rejected);
    expect(h.fake.emails.filter((e) => e.template?.id?.startsWith('hf-story-live'))).toHaveLength(1);
    expect(await h.db(`SELECT reviewed_by FROM stories`)).toEqual([{ reviewed_by: 'boss@example.com' }]);
    const again = await h.request('POST', '/api/lab/review', { token: 'shcat_boss', body: { type: 'story', id: 1, decision: 'rejected' } });
    expect((await again.json()).error).toBe('already_reviewed');
    expect(await (await h.request('GET', '/api/lab/review', lab('shcat_boss'))).json()).toEqual({ suggestions: [], stories: [] });
  });
});
