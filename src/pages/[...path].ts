// Every request under the mount path (/join) goes to the backend app.
import type { APIRoute } from 'astro';
import { createApp } from '../core/app';
import type { Env } from '../core/env';

export const prerender = false;

const app = createApp({ basePath: import.meta.env.BASE_URL || '/join' });

export const ALL: APIRoute = async ({ request, locals }) => {
  const runtime = (locals as unknown as { runtime: { env: Env; ctx: { waitUntil(p: Promise<unknown>): void } } }).runtime;
  return app.handle(request, runtime.env, runtime.ctx);
};
