# Happiness Foundation backend

A Webflow Cloud app attached to the Happiness Foundation site and served from
`/join`. It is built in phases from [BRIEF.md](BRIEF.md); this branch holds
**Phase 1: Foundation**.

- Astro 5 on Webflow Cloud (Cloudflare Workers runtime)
- Webflow Cloud SQLite (`DB`), key-value store (`CACHE`) and object storage (`MEDIA`), declared in `wrangler.json`
- Schema in `migrations/`, applied by Webflow Cloud on deploy
- All logic in `src/core/`; `src/pages/[...path].ts` hands every request to it
- `public/hf-backend.js` is the helper the Webflow site loads from `/join/hf-backend.js`

## Where text lives (decided Nov 17, 2026)

Each kind of text has one home. Don't move text between them.

| Kind of text | Home | How it reaches the site |
| --- | --- | --- |
| Page content: headlines and intros on the foundation site | **Webflow** (Designer and CMS) | Native Webflow elements. Scripts only show the right one (`data-hf-show`) and fill in data (`data-hf-fill`). |
| Product facts: names, descriptions, prices, images, edition sizes, drop dates | **Shopify** | Copied into the Webflow Drops and Shop products collections by the backend (`shop.ts`). Shop and product page text and design are Webflow's. |
| Member emails | **Resend** templates (`hf-invite-joined-*`, `hf-story-live*`, `hf-suggestion-live*`, `hf-pledge-reminder`, and `hf-pledge-claim` by its ID) | The backend sends the template alias (or ID) and its variables. |
| Form labels, help lines and thank-you messages | **Webflow** (the native forms) | The scripts read the fields by id. |
| Interface text: buttons, labels, messages, errors | **`src/wording/en.json`** | The backend imports it; the page scripts get it as `/join/hf-wording.js`. |

Rules for `en.json`: one key per text, `{name}`-style parts are filled in by the code. Edit it on GitHub (pencil icon) and open a pull request: tests check that every key the code uses exists, that each call fills in exactly the text's `{parts}`, and that no key is unused (`tests/wording.test.ts`). `tests/no-text-in-code.test.ts` fails if a sentence is written into the code instead. Staff-only text (/lab, admin emails) stays in code.

The design is native in Webflow: colours, fonts and sizes are Webflow Variables (`Colour/…`, `Font/…`, `Size/…`), every class has its real styles there (with tablet and phone breakpoints), and the Style Guide page shows the system. Restyle in the Designer, not in code. Forms are Webflow forms (Suggest an action, Share your story, account settings); the page scripts only fill them in and send them to the backend. `public/site.css` holds just what Webflow cannot express (tag-only rules, the menu's current state, `:has` and sibling spacing, focus rings, reduced motion, script-filled parts), using the same Variables. Site-wide behaviour (sign-in window, Keep your pledge, live account data) is in `public/hf-pages.js`. Webflow keeps only the stable lines in `site/site-head.html` and `site/site-loader.js`.

## Run the tests

```bash
npm install
npm test
```

The tests use Miniflare, the same SQLite, key-value and object storage that
Webflow Cloud runs, with fake Shopify, Webflow, Resend and Turnstile services.
`npm run typecheck` and `npm run build` check the app compiles for Webflow Cloud.

## Environment variables

Set these in the Webflow Cloud app settings, separately for each environment.
Mark the keys and secrets as secret. Never commit them; locally, copy
`dev.vars.example` to `dev.vars`, which git ignores.

| Name | Secret | What it is |
| --- | --- | --- |
| `ENVIRONMENT` | no | `test` or `live`, shown in error emails |
| `ALLOWED_ORIGINS` | no | Comma-separated site origins allowed to call the backend |
| `SHOPIFY_STORE_DOMAIN` | no | `r40e0y-zs.myshopify.com` |
| `SHOPIFY_CLIENT_ID` | no | Client ID of the Shopify Dev Dashboard app |
| `SHOPIFY_CLIENT_SECRET` | yes | That app's client secret. The backend exchanges ID and secret for a 24-hour Admin API token, and uses the secret to verify webhooks |
| `SHOPIFY_ADMIN_API_VERSION` | no | Optional, default `2026-07` |
| `SHOPIFY_STOREFRONT_TOKEN` | for the shop | Private Storefront API token of the **Happiness Foundation Headless** channel (Shopify admin › Headless › Storefront API). Makes checkouts; without it Buy says the shop is not open yet. The Shopify app needs the scopes `read_publications` and `write_publications` too (Dev Dashboard, released in backend-3) |
| `WEBFLOW_API_TOKEN` | yes | Site API token with CMS read and write |
| `RESEND_API_KEY` | yes | Resend API key for makeotherpeoplehappy.com (sending access only) |
| `MEMBERSTACK_SECRET_KEY` | yes | Memberstack secret key (`sk_sb_…` in test mode, `sk_…` live): checks member sign-ins |
| `MEMBERSTACK_WEBHOOK_SECRET` | yes | Signing secret of the Memberstack webhook (`whsec_…`), endpoint `/join/api/memberstack/webhook` (events: member updated, member deleted) |
| `EMAIL_FROM` | no | e.g. `Happiness Foundation <team@makeotherpeoplehappy.com>` |
| `ERROR_EMAIL_TO` | no | Where error reports go |
| `TURNSTILE_SECRET_KEY` | yes | Cloudflare Turnstile secret key |
| `JOBS_SECRET` | yes | Long random string; the 5-minute timer sends it |
| `ADMIN_SECRET` | yes | Long random string for the import and action sync |
| `LINK_SECRET` | yes | Long random string that signs unsubscribe links |

`GET /join/api/health` lists any that are missing, without showing values.

## Calls (Phase 1)

| Call | Who | |
| --- | --- | --- |
| `GET /api/actions/:id/state` | Anyone | Count (at 10 or more), can be done with others, approved stories; for a member also done, last done date, like |
| `POST /api/actions/:id/done` | Member | "I did this" (minimal; Phase 3 adds "again" and undo) |
| `POST /api/suggestions` | Member | Saves the idea and queues the Suggestions item |
| `POST /api/stories`, `DELETE /api/stories/:id` | Member | Text-only story for a done action (Phase 2 adds the rest) |
| `GET /api/me`, `PATCH /api/me/settings`, `DELETE /api/me` | Member | Account, notification settings, delete my data |
| `POST /api/intents`, `GET /api/intents/:id`, `POST /api/intents/:id/complete` | Anyone (bot check) / member | Resume a click after sign-in |
| `GET/POST /api/notifications/off?t=` | Email link | One-click unsubscribe |
| `POST /api/jobs/tick` | `JOBS_SECRET` | Retry queued writes, sync actions hourly |
| `POST /api/admin/sync-actions`, `POST /api/admin/import` | `ADMIN_SECRET` | Mirror actions; import metafields (`{"customerId": "7001"}` or page with `{"cursor": ...}`) |
| `POST /api/admin/shopify-webhooks` | `ADMIN_SECRET` | Register the Shopify webhooks (orders, refunds, products, customer deletion) for this address |
| `POST /api/webhooks/shopify` | Shopify (HMAC) | `customers/delete`, `customers/redact`, orders and refunds (pledges), `products/*` (refreshes drops) |

## The shop and drops

The shop runs on this site (Shop page `/shop`, product pages `/product/<handle>`,
designed natively in Webflow). Shopify keeps products, stock, checkout and
fulfilment; Memberstack keeps members (there are no Shopify customer logins).

- **Shopify → Webflow:** every drop and active product is copied into the Webflow
  **Drops** and **Shop products** collections (name, address, description, images,
  price, edition size, drop, drop date and early access). Product and collection
  webhooks queue a copy at once; the hourly `sync-shop` job is the safety net.
  Archived or deleted products leave the site (kept as drafts).
- **A drop** is a Shopify collection with a **Drop date** (collection field
  `custom.drop_date`). Its pieces are its products; each piece's size is its
  **Edition size** (`custom.edition_size`).
- **The home page hero** leads with the newest drop once it has a **Hero photo**
  (collection field `custom.hero_image`, a file). Also on the collection:
  **Hero headline** (`custom.hero_headline`; mark the accent word with asterisks,
  e.g. `Happiness is felt by making other people *happy*.`) and **Lead piece**
  (`custom.lead_product`; else the collection's first product). The copy also
  carries the drop's pieces, **sold out** (every piece counted, none left) and the
  switches the home page shows or hides its parts with (**Hero on**, **Hero off**,
  **Open**);
  orders, cancellations and refunds queue a copy so it follows stock. Until a drop
  has a hero photo, and once it is sold out, the home page shows its usual hero.
- **Early access:** Active members can buy `EARLY_ACCESS_HOURS` (24) before the drop
  date, one of each piece; everyone else from the drop date. Each upcoming drop's
  products are scheduled in Shopify to publish when early access opens (needs the
  app scopes `read_publications` and `write_publications`); the backend decides who
  may buy then.
- **Checkout:** `POST /api/shop/checkout {variant}` makes the Shopify cart with the
  Storefront API (`SHOPIFY_STOREFRONT_TOKEN`, the Headless channel's private token),
  fills in a signed-in member's email and puts the member on the order (hidden
  attribute `_hf_member`, signed), so the order's pledge joins them whatever email
  they type. `GET /api/shop/products/<handle>` gives a product page sizes, stock and
  whether this visitor can buy now.
- **Notify me** (`POST /api/shop/notify {drop, on}`) is kept with the member. Active
  members who asked are emailed when early access opens, everyone else when the
  drop opens (Resend template `hf-drop-open`, variables `DROP`, `URL`, `EARLY`).
- **Pledges:** every purchase makes one pledge; a drop's "pledges made, kept" counts
  the orders that hold one of its pieces.

## Going live on www.makeotherpeoplehappy.com

The site's address is **www.makeotherpeoplehappy.com** (happiness.foundation is the
old one). The backend already allows both makeotherpeoplehappy.com origins and
builds every link from the address a request came in on. On launch day:

1. **Webflow:** add the domain in Site settings › Publishing, point its DNS at
   Webflow, and publish to it.
2. **Timer:** nothing to do. It calls www.makeotherpeoplehappy.com first and the
   Webflow test address only while the new address isn't the backend yet, so it switches by
   itself once the site is published there.
3. **Resend:** add and verify makeotherpeoplehappy.com, then set `EMAIL_FROM` to an
   address on it (until then mail keeps coming from happiness.foundation).
4. **Memberstack:** the site head loads Memberstack from its custom domain
   `memberstack-client.happiness.foundation`; set up the same on
   makeotherpeoplehappy.com in Memberstack and update the site head.
5. **Shopify:** in the redirect theme's settings (Theme settings › Redirect) set the
   website address to `www.makeotherpeoplehappy.com`, then turn the store password
   off (checkout is blocked while it is on). Optional: a checkout subdomain such as
   checkout.makeotherpeoplehappy.com.

## The Make Someone Happy pledge

Every purchase from our own shop comes with a **Make Someone Happy pledge**.
There are no outside partner shops: the Pledge API, partner keys and partner
reports were removed in November 2026 (the `partners` table and the
`partner_id` columns stay, with our shop as id 1, so existing claim links keep
working).

Orders arrive through the Shopify webhook. An order joins the member with the
same verified email; otherwise the buyer is emailed a "Keep your pledge" link
(Resend template `hf-pledge-claim`, sent by its ID, variables `CLAIM_URL` and
`COUNT`; `claims.ts`). The link opens `/keep-your-pledge`; after signing in or
creating a free account the pledge is the member's, and nobody else can take
it. A partial refund keeps the pledge; a cancellation or full refund removes
it. A drop's "pledges made, kept" counts the orders that hold one of its
pieces.

## Calls from the site

Member calls send `Authorization: Bearer <Memberstack token>`. Every
write sends an `Idempotency-Key`; `hf-backend.js` does both.

## Scheduled jobs

`.github/workflows/jobs.yml` calls `/api/jobs/tick` every 5 minutes. Add the
repository secrets listed at the top of that file. Each write also retries a
few queued items straight away. Note that GitHub pauses scheduled workflows
in public repositories after 60 days without commits.
