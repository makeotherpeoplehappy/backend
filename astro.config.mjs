// Webflow Cloud sets `base` and `build.assetsPrefix` from the environment's
// mount path (/join) at build time, so they are left unset here.
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ platformProxy: { enabled: true } }),
});
