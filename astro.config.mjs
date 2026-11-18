// Webflow Cloud sets `base` and `build.assetsPrefix` from the environment's
// mount path (/join) at build time, so they are left unset here.
import { defineConfig } from 'astro/config';
import cloudflare from '@astrojs/cloudflare';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transform } from 'esbuild';
import { createHash } from 'node:crypto';

// The page scripts and stylesheet in public/ are kept readable in the repo and
// minified in the build output (esbuild ships with Astro). Same file names, so
// the Webflow site head needs no change. A file that fails to minify is left as is.
const MINIFY = ['hf-pages.js', 'hf-backend.js', 'lab.js', 'site.css'];
const minifyPublic = {
  name: 'hf-minify-public',
  hooks: {
    'astro:build:done': async ({ dir, logger }) => {
      // Version stamp for the page script and interface text: a hash of what ships,
      // written into hf-backend.js, which loads them as hf-pages.js?v=… .
      const hash = createHash('sha256');
      for (const f of ['public/hf-pages.js', 'src/wording/en.json']) hash.update(await readFile(new URL(f, import.meta.url)));
      const version = hash.digest('hex').slice(0, 12);
      const backendFile = fileURLToPath(new URL('hf-backend.js', dir));
      await writeFile(backendFile, (await readFile(backendFile, 'utf8')).replace('__HF_VERSION__', version));
      logger.info(`page scripts stamped v=${version}`);
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
