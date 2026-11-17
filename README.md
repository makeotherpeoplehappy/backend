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
| The shop: products, drops, edition sizes and all shop text | **Shopify** (admin and theme) | The shop is Shopify's own; the backend only reads it. |
| Member emails | **Resend** templates (`hf-invite-joined-*`, `hf-story-live*`, `hf-suggestion-live*`, `hf-pledge-reminder`, and `hf-pledge-claim` by its ID) | The backend sends the template alias (or ID) and its variables. |
| Interface text: buttons, labels, messages, errors | **`src/wording/en.json`** | The backend imports it; the page scripts get it as `/join/hf-wording.js`. |

Rules for `en.json`: one key per text, `{name}`-style parts are filled in by the code. Edit it on GitHub (pencil icon) and open a pull request: tests check that every key the code uses exists, that each call fills in exactly the text's `{parts}`, and that no key is unused (`tests/wording.test.ts`). `tests/no-text-in-code.test.ts` fails if a sentence is written into the code instead. Staff-only text (/lab, admin emails) stays in code.

Site styles and site-wide behaviour (sign-in window, Keep your pledge) are in this repo too (`public/site.css`, `public/hf-pages.js`). Webflow keeps only the stable lines in `site/site-head.html` and `site/site-loader.js`.

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
| `WEBFLOW_API_TOKEN` | yes | Site API token with CMS read and write |
| `RESEND_API_KEY` | yes | Resend API key for happiness.foundation (sending access only) |
| `MEMBERSTACK_SECRET_KEY` | yes | Memberstack secret key (`sk_sb_…` in test mode, `sk_…` live): checks member sign-ins |
| `MEMBERSTACK_WEBHOOK_SECRET` | yes | Signing secret of the Memberstack webhook (`whsec_…`), endpoint `/join/api/memberstack/webhook` (events: member updated, member deleted) |
| `EMAIL_FROM` | no | e.g. `Happiness Foundation <team@happiness.foundation>` |
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

## Drops (in Shopify)

A drop is a Shopify collection with a **Drop date** (collection field
`custom.drop_date`, date and time). Everything else is worked out:

- **Pieces:** the collection's products. Each piece's size is its **Edition size**
  (product field `custom.edition_size`); the drop's total is the sizes added up.
- **Status:** upcoming before the drop date, live after it, sold out once every
  piece is gone.
- **Current drop** (home page, `/api/drops/state` without a name): the newest drop
  on sale, else the next one coming up, else the most recent one.
- **Early buying is impossible:** each upcoming drop's products are scheduled in
  Shopify to publish at the drop date (needs the app scopes `read_publications`
  and `write_publications`).
- **Pledges:** every purchase in the shop makes one pledge; a drop's
  "pledges made, kept" counts the orders that hold one of its pieces.
- **Notify me:** Shopify customers tagged `notify-drop-<handle>`; send the "it's
  live" email with Shopify Email.

## Partner pledges

Every purchase comes with one pledge, in any shop: ours (partner 1) or a
partner's. The shop never needs the buyer's account: it registers the order and
gives the buyer a link.

1. In `/lab`, an owner adds the partner under **Partners**. The key (`hfp_…`) is
   shown once; only its hash is stored. The partner can be switched off there.
2. When an order is paid, the shop's server calls:

   ```
   POST /join/api/partners/pledges
   Authorization: Bearer hfp_…
   {"order": "A-1001", "email": "optional", "orderedAt": "optional ISO date"}
   ```

   Answer: `{"order", "pledge": "open", "claimUrl"}`. Safe to repeat. A
   cancelled or fully refunded order: `POST /join/api/partners/pledges/cancel`
   with `{"order": "A-1001"}` (sending the order again opens it again).
3. The shop shows `claimUrl` on its thank-you page or in its order email. It
   opens `/keep-your-pledge`; after signing in or creating a free account the
   pledge is the member's. A claimed link cannot be taken by someone else.
   If `email` matches a member's verified email, the pledge attaches at once.

Our own shop's orders arrive through the Shopify webhook and get the same claim
link; buyers without an account get it by email (Resend template
`hf-pledge-claim`, sent by its ID, variables `CLAIM_URL` and `COUNT`). A partial
refund keeps the pledge; a cancellation or full refund removes it. A drop's
"pledges made, kept" counts the orders that hold one of its pieces.

## Calls from the site

Member calls send `Authorization: Bearer <Memberstack token>`. Every
write sends an `Idempotency-Key`; `hf-backend.js` does both.

## Scheduled jobs

`.github/workflows/jobs.yml` calls `/api/jobs/tick` every 5 minutes. Add the
repository secrets listed at the top of that file. Each write also retries a
few queued items straight away. Note that GitHub pauses scheduled workflows
in public repositories after 60 days without commits.
