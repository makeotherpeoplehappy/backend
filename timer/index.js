// Happiness Foundation timer: a Cloudflare Worker that runs every 5 minutes
// (Cron Trigger) and asks the backend to do its scheduled jobs. Replaces the
// GitHub Actions timer, which ran late and pauses after 60 quiet days.
//
// Settings (Cloudflare > Workers > hf-timer > Settings > Variables):
//   JOBS_URL     plain   https://<site>/join/api/jobs/tick
//   JOBS_SECRET  secret  the same value as JOBS_SECRET in Webflow Cloud

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(tick(env));
  },
  // Visiting the worker's address shows that it is alive; it never runs the jobs.
  async fetch() {
    return new Response('Happiness Foundation timer. Runs every 5 minutes.', { headers: { 'Content-Type': 'text/plain' } });
  },
};

async function tick(env) {
  const res = await fetch(env.JOBS_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.JOBS_SECRET}`, 'User-Agent': 'HappinessFoundationTimer/1.0' },
  });
  if (!res.ok) {
    // Shows in Cloudflare > Workers > hf-timer > Logs.
    console.error(`jobs tick answered ${res.status}: ${(await res.text()).slice(0, 300)}`);
    throw new Error(`jobs tick failed with ${res.status}`);
  }
  console.log(`jobs tick ok: ${(await res.text()).slice(0, 300)}`);
}
