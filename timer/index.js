// Happiness Foundation timer: a Cloudflare Worker that runs every 5 minutes
// (Cron Trigger) and asks the backend to do its scheduled jobs. Replaces the
// GitHub Actions timer, which ran late and pauses after 60 quiet days.
//
// Settings (Cloudflare > Workers > hf-timer > Settings > Variables):
//   JOBS_URL          plain   https://www.makeotherpeoplehappy.com/join/api/jobs/tick
//   JOBS_FALLBACK_URL plain   https://happiness-foundation.webflow.io/join/api/jobs/tick
//   JOBS_SECRET       secret  the same value as JOBS_SECRET in Webflow Cloud
//
// The jobs build their email links from the address they are called on, so the
// timer calls the site's own address. Until the site is published there, that
// address is not the backend (it answers with an HTML error page, or not at all),
// so nothing ran and the timer calls the Webflow test address instead. Once the
// site is live on its domain, it switches by itself.

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  // Visiting the worker's address shows that it is alive; it never runs the jobs.
  async fetch() {
    return new Response('Happiness Foundation timer. Runs every 5 minutes.', { headers: { 'Content-Type': 'text/plain' } });
  },
};

async function call(url, env) {
  return fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.JOBS_SECRET}`, 'User-Agent': 'HappinessFoundationTimer/1.1' },
  });
}

/** The backend always answers in JSON; anything else is not the backend. */
const fromBackend = (res) => (res.headers.get('content-type') || '').includes('application/json');

async function tick(env) {
  let url = env.JOBS_URL;
  let res = await call(url, env).catch(() => null);
  if ((!res || !fromBackend(res)) && env.JOBS_FALLBACK_URL) {
    url = env.JOBS_FALLBACK_URL;
    res = await call(url, env);
  }
  if (!res) throw new Error(`jobs tick: no answer from ${url}`);
  if (!res.ok) {
    // Shows in Cloudflare > Workers > hf-timer > Logs.
    console.error(`jobs tick at ${url} answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    throw new Error(`jobs tick failed with ${res.status}`);
  }
  console.log(`jobs tick ok at ${url}: ${(await res.text()).slice(0, 300)}`);
}
