// Short video stories: uploaded to the backend's own storage (R2) in parts, so
// a weak phone connection can retry a part instead of starting over. The
// browser checks the video first (vertical, 15–30 seconds, at most 100 MB);
// the backend checks again by reading the file's own header once it is in.

import type { Deps, Env } from '../env';
import { HttpError, base64url, iso } from '../http';
import type { Member } from '../identity';

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;
export const PART_BYTES = 8 * 1024 * 1024;
export const MIN_SECONDS = 15;
export const MAX_SECONDS = 30;
const VIDEOS_PER_DAY = 5;
const KEY = /^videos\/[A-Za-z0-9_-]{20,40}\.(mp4|mov)$/;

interface Pending {
  key: string;
  memberId: number;
  size: number;
}

export async function startVideo(env: Env, deps: Deps, member: Member, body: { size?: unknown; type?: unknown }) {
  const size = Number(body.size);
  const type = String(body.type || '').toLowerCase();
  if (!(size > 0)) throw new HttpError(400, 'video_invalid', 'err-video-unreadable');
  if (size > MAX_VIDEO_BYTES) throw new HttpError(413, 'video_too_large', 'err-video-too-large');
  if (type !== 'video/mp4' && type !== 'video/quicktime') throw new HttpError(415, 'video_type', 'err-video-type');
  const dayKey = `videos:${member.id}:${iso(deps.now()).slice(0, 10)}`;
  const used = Number((await env.CACHE.get(dayKey)) || '0');
  if (used >= VIDEOS_PER_DAY) throw new HttpError(429, 'daily_limit', 'err-limit-videos');
  await env.CACHE.put(dayKey, String(used + 1), { expirationTtl: 2 * 86_400 });
  const key = `videos/${base64url(crypto.getRandomValues(new Uint8Array(18)))}.${type === 'video/quicktime' ? 'mov' : 'mp4'}`;
  const up = await env.MEDIA.createMultipartUpload(key, { httpMetadata: { contentType: 'video/mp4', cacheControl: 'public, max-age=31536000, immutable' } });
  const pending: Pending = { key, memberId: member.id, size };
  await env.CACHE.put(`vup:${up.uploadId}`, JSON.stringify(pending), { expirationTtl: 86_400 });
  return { uploadId: up.uploadId, key, partSize: PART_BYTES, parts: Math.ceil(size / PART_BYTES) };
}

async function pendingFor(env: Env, member: Member, uploadId: string): Promise<Pending> {
  const p = uploadId ? ((await env.CACHE.get(`vup:${uploadId}`, 'json')) as Pending | null) : null;
  if (!p || p.memberId !== member.id) throw new HttpError(404, 'upload_not_found', 'err-video-upload-gone');
  return p;
}

export async function uploadVideoPart(env: Env, member: Member, uploadId: string, partNumber: number, req: Request) {
  const p = await pendingFor(env, member, uploadId);
  const parts = Math.ceil(p.size / PART_BYTES);
  if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > parts) throw new HttpError(400, 'video_part', 'err-video-unreadable');
  const body = new Uint8Array(await req.arrayBuffer());
  const expected = partNumber < parts ? PART_BYTES : p.size - PART_BYTES * (parts - 1);
  if (body.length !== expected) throw new HttpError(400, 'video_part', 'err-video-unreadable');
  const part = await env.MEDIA.resumeMultipartUpload(p.key, uploadId).uploadPart(partNumber, body);
  return { partNumber: part.partNumber, etag: part.etag };
}

export async function completeVideo(env: Env, member: Member, body: { uploadId?: unknown; parts?: unknown }) {
  const uploadId = String(body.uploadId || '');
  const p = await pendingFor(env, member, uploadId);
  const parts = Array.isArray(body.parts) ? (body.parts as { partNumber: number; etag: string }[]) : [];
  const up = env.MEDIA.resumeMultipartUpload(p.key, uploadId);
  try {
    await up.complete(parts.map((x) => ({ partNumber: Number(x.partNumber), etag: String(x.etag) })));
  } catch {
    throw new HttpError(400, 'video_incomplete', 'err-video-upload-gone');
  }
  await env.CACHE.delete(`vup:${uploadId}`);
  const info = await readVideoInfo(env, p.key);
  const problem = !info ? 'err-video-unreadable' : info.height <= info.width ? 'err-video-not-vertical' : info.seconds < MIN_SECONDS - 0.5 ? 'err-video-too-short' : info.seconds > MAX_SECONDS + 0.99 ? 'err-video-too-long' : null;
  if (problem) {
    await env.MEDIA.delete(p.key);
    throw new HttpError(422, 'video_rejected', problem);
  }
  await env.CACHE.put(`upload:${p.key}`, String(member.id), { expirationTtl: 2 * 86_400 });
  await env.CACHE.put(`vinfo:${p.key}`, JSON.stringify(info), { expirationTtl: 2 * 86_400 });
  return { videoKey: p.key, seconds: Math.round(info!.seconds * 10) / 10, width: info!.width, height: info!.height, codec: info!.codec };
}

/** Serves a story video, with byte ranges (phones need them to play and seek). */
export async function serveVideo(env: Env, key: string, req: Request): Promise<Response> {
  if (!KEY.test(key)) return new Response('Not found', { status: 404 });
  const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.get('Range') || '');
  const head = await env.MEDIA.head(key);
  if (!head) return new Response('Not found', { status: 404 });
  const headers: Record<string, string> = { 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes', 'Cache-Control': 'public, max-age=31536000, immutable' };
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), head.size - 1) : head.size - 1;
    if (start >= head.size || end < start) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${head.size}` } });
    const obj = await env.MEDIA.get(key, { range: { offset: start, length: end - start + 1 } });
    return new Response(obj!.body, { status: 206, headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${head.size}`, 'Content-Length': String(end - start + 1) } });
  }
  const obj = await env.MEDIA.get(key);
  return new Response(obj!.body, { headers: { ...headers, 'Content-Length': String(head.size) } });
}

// --- Reading an MP4 / MOV header ---------------------------------------------

export interface VideoInfo {
  seconds: number;
  width: number;
  height: number;
  codec: string | null;
}

const u32 = (b: Uint8Array, o: number) => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
const type4 = (b: Uint8Array, o: number) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
const fixed = (b: Uint8Array, o: number) => (u32(b, o) | 0) / 65536;

function children(b: Uint8Array, start: number, end: number): { type: string; start: number; end: number }[] {
  const out = [];
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o);
    const type = type4(b, o + 4);
    let header = 8;
    if (size === 1) {
      size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12);
      header = 16;
    } else if (size === 0) size = end - o;
    if (size < header || o + size > end) break;
    out.push({ type, start: o + header, end: o + size });
    o += size;
  }
  return out;
}

/** Duration, displayed size (rotation applied) and codec, from the `moov` box. */
export function parseMoov(m: Uint8Array): VideoInfo | null {
  const top = children(m, 0, m.length);
  const moov = top.find((x) => x.type === 'moov');
  const kids = moov ? children(m, moov.start, moov.end) : top;
  const mvhd = kids.find((x) => x.type === 'mvhd');
  if (!mvhd) return null;
  const v = m[mvhd.start];
  const scale = v === 1 ? u32(m, mvhd.start + 20) : u32(m, mvhd.start + 12);
  const dur = v === 1 ? u32(m, mvhd.start + 24) * 2 ** 32 + u32(m, mvhd.start + 28) : u32(m, mvhd.start + 16);
  if (!scale) return null;
  for (const trak of kids.filter((x) => x.type === 'trak')) {
    const t = children(m, trak.start, trak.end);
    const mdia = t.find((x) => x.type === 'mdia');
    const hdlr = mdia && children(m, mdia.start, mdia.end).find((x) => x.type === 'hdlr');
    if (!hdlr || type4(m, hdlr.start + 8) !== 'vide') continue;
    const tkhd = t.find((x) => x.type === 'tkhd');
    if (!tkhd) continue;
    const tv = m[tkhd.start];
    const mat = tkhd.start + (tv === 1 ? 52 : 40);
    let width = fixed(m, mat + 36);
    let height = fixed(m, mat + 40);
    // A phone often stores the picture sideways with a turn in the matrix.
    const a = fixed(m, mat), b = fixed(m, mat + 4);
    if (Math.abs(a) < 0.01 && Math.abs(Math.abs(b) - 1) < 0.01) [width, height] = [height, width];
    let codec: string | null = null;
    const minf = children(m, mdia!.start, mdia!.end).find((x) => x.type === 'minf');
    const stbl = minf && children(m, minf.start, minf.end).find((x) => x.type === 'stbl');
    const stsd = stbl && children(m, stbl.start, stbl.end).find((x) => x.type === 'stsd');
    if (stsd && stsd.start + 16 <= stsd.end) codec = type4(m, stsd.start + 12);
    return { seconds: dur / scale, width: Math.round(width), height: Math.round(height), codec };
  }
  return null;
}

/** Finds the `moov` box in the stored file (it can be at the start or the end) and reads it. */
export async function readVideoInfo(env: Env, key: string): Promise<VideoInfo | null> {
  const head = await env.MEDIA.head(key);
  if (!head) return null;
  let o = 0;
  for (let i = 0; i < 64 && o + 8 <= head.size; i++) {
    const h = await env.MEDIA.get(key, { range: { offset: o, length: 16 } });
    const b = new Uint8Array(await h!.arrayBuffer());
    let size = u32(b, 0);
    const type = type4(b, 4);
    if (size === 1) size = u32(b, 8) * 2 ** 32 + u32(b, 12);
    else if (size === 0) size = head.size - o;
    if (size < 8) return null;
    if (type === 'moov') {
      if (size > 16 * 1024 * 1024) return null;
      const box = await env.MEDIA.get(key, { range: { offset: o, length: size } });
      return parseMoov(new Uint8Array(await box!.arrayBuffer()));
    }
    o += size;
  }
  return null;
}
