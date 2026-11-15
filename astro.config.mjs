// Webflow Cloud sets `base` and `build.assetsPrefix` from the environment's
// mount path (/join) at build time, so they are left unset here.
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ platformProxy: { enabled: true } }),
  // Astro's built-in check refuses cross-site POSTs that look like form
  // submissions. It blocked the jobs timer and would block one-click
  // unsubscribe from email apps. The backend checks every call itself:
  // site calls by origin, sign-in and one-time key; jobs, admin and
  // webhooks by secret or signature.
  security: { checkOrigin: false },
});
