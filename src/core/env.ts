// Bindings and environment variables. Storage bindings are declared in
// wrangler.json; every key and setting below is set per environment in the
// Webflow Cloud app settings (or dev.vars locally) and never committed.

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  MEDIA: R2Bucket;

  /** test | live */
  ENVIRONMENT?: string;
  /** Comma-separated origins allowed to call the backend. */
  ALLOWED_ORIGINS: string;

  /** e.g. r40e0y-zs.myshopify.com */
  SHOPIFY_STORE_DOMAIN: string;
  /** Admin API access token of the Shopify app. */
  SHOPIFY_ADMIN_TOKEN: string;
  /** Shopify app client secret, used to verify webhooks. */
  SHOPIFY_WEBHOOK_SECRET: string;
  SHOPIFY_ADMIN_API_VERSION?: string;

  /** Webflow site API token with CMS read and write. */
  WEBFLOW_API_TOKEN: string;

  RESEND_API_KEY: string;
  /** e.g. Happiness Foundation <hello@happiness.foundation> */
  EMAIL_FROM: string;
  /** Where error reports go. */
  ERROR_EMAIL_TO: string;

  TURNSTILE_SECRET_KEY: string;

  /** Bearer secret for the scheduled jobs endpoint. */
  JOBS_SECRET: string;
  /** Bearer secret for admin endpoints (import, action sync). */
  ADMIN_SECRET: string;
  /** Signs links in emails (unsubscribe). */
  LINK_SECRET: string;
}

const REQUIRED: (keyof Env)[] = [
  'ALLOWED_ORIGINS',
  'SHOPIFY_STORE_DOMAIN',
  'SHOPIFY_ADMIN_TOKEN',
  'SHOPIFY_WEBHOOK_SECRET',
  'WEBFLOW_API_TOKEN',
  'RESEND_API_KEY',
  'EMAIL_FROM',
  'ERROR_EMAIL_TO',
  'TURNSTILE_SECRET_KEY',
  'JOBS_SECRET',
  'ADMIN_SECRET',
  'LINK_SECRET',
];

export const ENV_VAR_NAMES = REQUIRED;

export function missingEnv(env: Partial<Env>): string[] {
  const missing: string[] = REQUIRED.filter((k) => !env[k]);
  for (const b of ['DB', 'CACHE', 'MEDIA'] as const) {
    if (!env[b]) missing.push(`binding ${b}`);
  }
  return missing;
}

export function allowedOrigins(env: Env): Set<string> {
  return new Set(
    (env.ALLOWED_ORIGINS || '')
      .split(',')
      .map((s) => s.trim().replace(/\/$/, ''))
      .filter(Boolean),
  );
}

/** Things the app needs from the outside world, swappable in tests. */
export interface Deps {
  fetch: typeof fetch;
  now: () => Date;
}

export interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

export const defaultDeps = (): Deps => ({
  fetch: (input, init) => fetch(input, init),
  now: () => new Date(),
});
