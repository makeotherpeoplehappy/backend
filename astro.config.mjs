// Webflow Cloud sets `base` and `build.assetsPrefix` from the environment's
// mount path (/join) at build time, so they are left unset here.
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';

// The page scripts and stylesheet in public/ are kept readable in the repo and
// minified in the build output (esbuild ships with Astro). Same file names, so
// the Webflow site head needs no change. A file that fails to minify is left as is.
const MINIFY = ['hf-pages.js', 'hf-backend.js', 'lab.js', 'site.css'];
const minifyPublic = {
  name: 'hf-minify-public',
  hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      for (const name of MINIFY) {
        const file = fileURLToPath(new URL(name, dir));
        let code;
        try { code = await readFile(file, 'utf8'); } catch { continue; }
        try {
          const out = await transform(code, { loader: name.endsWith('.css') ? 'css' : 'js', minify: true, target: 'es2019', legalComments: 'none' });
          await writeFile(file, out.code);
          logger.info(`${name}: ${code.length} → ${out.code.length} bytes`);
        } catch (e) {
          logger.warn(`${name} not minified: ${e.message}`);
        }
      }
    },
  },
};

export default defineConfig({
  output: 'server',
  adapter: cloudflare({ platformProxy: { enabled: true } }),
  integrations: [minifyPublic],
  // Astro's built-in check refuses cross-site POSTs that look like form
  // submissions. It blocked the jobs timer and would block one-click
  // unsubscribe from email apps. The backend checks every call itself:
  // site calls by origin, sign-in and one-time key; jobs, admin and
  // webhooks by secret or signature.
  security: { checkOrigin: false },
});
