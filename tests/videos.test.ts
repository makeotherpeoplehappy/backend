// Short video stories: the header check (length, upright, codec), the upload in
// parts, the questions on the story, serving with byte ranges, and the friendly
// email when a video story is not used.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyStory } from '../src/core/features/review';
import { parseMoov } from '../src/core/features/videos';
import { createHarness, SITE, type Harness } from './harness';

// --- A tiny MP4 made of boxes --------------------------------------------------
const enc = new TextEncoder();
function u32(n: number) { return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]; }
function box(type: string, ...parts: (number[] | Uint8Array)[]): Uint8Array {
  const body = parts.flatMap((p) => Array.from(p));
  return new Uint8Array([...u32(8 + body.length), ...enc.encode(type), ...body]);
}
const fx = (v: number) => u32(Math.round(v * 65536) >>> 0);
function mp4(o: { seconds: number; w: number; h: number; turned?: boolean; codec?: string; moovFirst?: boolean }) {
  const mvhd = box('mvhd', [0, 0, 0, 0], u32(0), u32(0), u32(600), u32(Math.round(o.seconds * 600)), new Array(80).fill(0));
  const matrix = o.turned ? [...fx(0), ...fx(1), ...u32(0), ...fx(-1), ...fx(0), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)] : [...fx(1), ...u32(0), ...u32(0), ...u32(0), ...fx(1), ...u32(0), ...u32(0), ...u32(0), ...u32(0x40000000)];
  const tkhd = box('tkhd', [0, 0, 0, 3], u32(0), u32(0), u32(1), u32(0), u32(0), new Array(8).fill(0), [0, 0, 0, 0, 0, 0, 0, 0], matrix, fx(o.turned ? o.h : o.w), fx(o.turned ? o.w : o.h));
  const hdlr = box('hdlr', [0, 0, 0, 0], u32(0), enc.encode('vide'), new Array(12).fill(0), [0]);
  const stsd = box('stsd', [0, 0, 0, 0], u32(1), box(o.codec || 'avc1', new Array(78).fill(0)));
  const trak = box('trak', tkhd, box('mdia', hdlr, box('minf', box('stbl', stsd))));
  const moov = box('moov', mvhd, trak);
  const ftyp = box('ftyp', enc.encode('isom'), u32(0), enc.encode('isommp41'));
  const mdat = box('mdat', new Array(4000).fill(7));
  return new Uint8Array([...ftyp, ...(o.moovFirst ? [...moov, ...mdat] : [...mdat, ...moov])]);
}

describe('Reading the video header', () => {
  it('reads length, upright size and codec', () => {
    expect(parseMoov(mp4({ seconds: 20, w: 1080, h: 1920 }))).toEqual({ seconds: 20, width: 1080, height: 1920, codec: 'avc1' });
  });
  it('turns a sideways-stored phone video upright', () => {
    expect(parseMoov(mp4({ seconds: 18, w: 1080, h: 1920, turned: true, codec: 'hvc1' }))).toMatchObject({ width: 1080, height: 1920, codec: 'hvc1' });
  });
});

let h: Harness;
let action: string;
beforeEach(async () => {
  h = await createHarness();
  action = h.fake.addAction('compliment-a-stranger', 'Compliment a stranger');
  h.fake.signIn('ms_ana', { id: 'mem_ana', firstName: 'Ana', email: 'ana@example.com' });
  await h.request('POST', `/api/actions/${action}/done`, { token: 'ms_ana' });
});
afterEach(async () => {
  await h.settle();
  await h.mf.dispose();
});

async function upload(file: Uint8Array) {
  const s = await h.request('POST', '/api/stories/video/start', { token: 'ms_ana', body: { size: file.length, type: 'video/mp4' } });
  expect(s.status).toBe(201);
  const st = await s.json();
  const p = await h.app.handle(
    new Request(`${SITE}/join/api/stories/video/part?u=${encodeURIComponent(st.uploadId)}&n=1`, { method: 'PUT', headers: { Origin: SITE, Authorization: 'Bearer ms_ana' }, body: file }),
    h.env,
    { waitUntil: () => undefined },
  );
  expect(p.status).toBe(200);
  const part = await p.json();
  return h.request('POST', '/api/stories/video/complete', { token: 'ms_ana', body: { uploadId: st.uploadId, parts: [part] } });
}

describe('Uploading', () => {
  it('accepts an upright 15–30 second video, wherever its header sits', async () => {
    for (const moovFirst of [false, true]) {
      const r = await upload(mp4({ seconds: 22, w: 1080, h: 1920, moovFirst }));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ seconds: 22, width: 1080, height: 1920, codec: 'avc1' });
    }
  });

  it('refuses too short, too long, sideways and too big, and keeps nothing', async () => {
    expect((await (await upload(mp4({ seconds: 9, w: 1080, h: 1920 }))).json()).message).toContain('at least 15 seconds');
    expect((await (await upload(mp4({ seconds: 45, w: 1080, h: 1920 }))).json()).message).toContain('at most 30 seconds');
    expect((await (await upload(mp4({ seconds: 20, w: 1920, h: 1080 }))).json()).message).toContain('vertical');
    const big = await h.request('POST', '/api/stories/video/start', { token: 'ms_ana', body: { size: 101 * 1024 * 1024, type: 'video/mp4' } });
    expect(big.status).toBe(413);
    expect((await h.env.MEDIA.list({ prefix: 'videos/' })).objects).toHaveLength(0);
  });

  it('needs sign-in', async () => {
    expect((await h.request('POST', '/api/stories/video/start', { body: { size: 10, type: 'video/mp4' } })).status).toBe(401);
  });
});

describe('The story', () => {
  async function videoKey() {
    return (await (await upload(mp4({ seconds: 20, w: 1080, h: 1920 }))).json()).videoKey as string;
  }

  it('asks that everyone agreed and whether children are in it', async () => {
    const key = await videoKey();
    const base = { actionId: action, consent: true, videoKey: key };
    expect((await (await h.request('POST', '/api/stories', { token: 'ms_ana', body: { ...base, childrenInVideo: false } })).json()).error).toBe('video_consent_required');
    expect((await (await h.request('POST', '/api/stories', { token: 'ms_ana', body: { ...base, videoConsent: true } })).json()).error).toBe('video_children_required');
    const ok = await h.request('POST', '/api/stories', { token: 'ms_ana', body: { ...base, videoConsent: true, childrenInVideo: true } });
    expect(ok.status).toBe(201);
    const row = (await h.db<{ video_key: string; has_children: number; status: string }>('SELECT video_key, has_children, status FROM stories'))[0];
    expect(row).toMatchObject({ video_key: key, has_children: 1, status: 'new' });
  });

  it("refuses someone else's upload", async () => {
    const key = await videoKey();
    h.fake.signIn('ms_ben', { id: 'mem_ben', firstName: 'Ben', email: 'ben@example.com' });
    await h.request('POST', `/api/actions/${action}/done`, { token: 'ms_ben' });
    const r = await h.request('POST', '/api/stories', { token: 'ms_ben', body: { actionId: action, consent: true, videoKey: key, videoConsent: true, childrenInVideo: false } });
    expect(r.status).toBe(400);
  });

  it('serves the video with byte ranges', async () => {
    const key = await videoKey();
    const r = await h.request('GET', `/media/${key}`, { headers: { Range: 'bytes=0-9' }, origin: null });
    expect(r.status).toBe(206);
    expect(r.headers.get('Content-Range')).toMatch(/^bytes 0-9\/\d+$/);
    expect((await r.arrayBuffer()).byteLength).toBe(10);
  });

  it('a video story that is not used gets a friendly email', async () => {
    const key = await videoKey();
    const created = await (await h.request('POST', '/api/stories', { token: 'ms_ana', body: { actionId: action, consent: true, videoKey: key, videoConsent: true, childrenInVideo: false } })).json();
    await applyStory(h.env, h.app.deps, created.id, 'cms_story_1', 'rejected', `${SITE}/join`);
    const mail = await h.db<{ payload: string }>(`SELECT payload FROM outbox WHERE dedupe_key LIKE 'video-not-used:%'`);
    expect(mail).toHaveLength(1);
    const msg = JSON.parse(mail[0].payload).message;
    expect(msg).toMatchObject({ to: 'ana@example.com', subject: 'About the video you shared' });
    expect(msg.text).toContain('Hi Ana');
    expect(msg.text).toContain('Compliment a stranger');
  });
});
