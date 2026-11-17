/**
 * An error answered to the caller. `message` is either a wording key
 * ("err-...", worded from src/wording/en.json) or, for
 * staff-only and technical errors, the text itself.
 */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public headers: Record<string, string> = {},
  ) {
    super(message);
  }
}

/** A dependency (Shopify, Webflow, email) is unreachable or failing. */
export class UpstreamError extends Error {
  constructor(
    public service: string,
    public status: number,
    message: string,
    public retryAfterSeconds?: number,
  ) {
    super(message);
  }
  get retryable(): boolean {
    return this.status === 0 || this.status === 429 || this.status >= 500;
  }
}

export function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers },
  });
}

export function errorResponse(err: HttpError, wording: Record<string, string> = {}): Response {
  const message = err.message.startsWith('err-') ? wording[err.message] || wording['error-something'] || '' : err.message;
  return json({ error: err.code, message }, err.status, err.headers);
}

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (!text) return {} as T;
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as T;
  } catch {
    throw new HttpError(400, 'invalid_json', 'err-invalid-json');
  }
}

/** fetch with a timeout; network failures become UpstreamError(status 0). */
export async function callUpstream(
  doFetch: typeof fetch,
  service: string,
  url: string,
  init: RequestInit,
  timeoutMs = 10_000,
): Promise<Response> {
  // Some services refuse requests that do not say what they are.
  const headers = new Headers(init.headers);
  if (!headers.has('User-Agent')) headers.set('User-Agent', 'HappinessFoundationBackend/1.0 (+https://happiness.foundation)');
  try {
    return await doFetch(url, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
  } catch (e) {
    throw new UpstreamError(service, 0, `${service} unreachable: ${(e as Error).message}`);
  }
}

export function retryAfterSeconds(res: Response): number | undefined {
  const h = res.headers.get('Retry-After');
  if (!h) return undefined;
  const n = Number(h);
  if (Number.isFinite(n)) return n;
  const d = Date.parse(h);
  return Number.isFinite(d) ? Math.max(0, Math.ceil((d - Date.now()) / 1000)) : undefined;
}

export function iso(d: Date): string {
  return d.toISOString();
}

export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function randomId(bytes = 16): string {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return base64url(a);
}

export function base64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function hmac(secret: string, data: string | Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, bytes as BufferSource));
}

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function bearer(req: Request): string | null {
  const h = req.headers.get('Authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h);
  return m ? m[1].trim() : null;
}

export function requireSecret(req: Request, secret: string): void {
  const got = bearer(req);
  if (!secret || !got || !timingSafeEqual(got, secret)) {
    throw new HttpError(401, 'unauthorized', 'Not authorised.');
  }
}

/** Accepts a site path ("/actions/x") or a URL on an allowed origin; returns a path. */
export function safeReturnTo(value: unknown, origins: Set<string>): string | null {
  if (typeof value !== 'string' || !value) return null;
  if (value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')) return value.slice(0, 500);
  try {
    const u = new URL(value);
    if (origins.has(u.origin)) return (u.pathname + u.search + u.hash).slice(0, 500);
  } catch {
    /* not a URL */
  }
  return null;
}
