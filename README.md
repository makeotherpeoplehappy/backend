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

## Pledge API (the Make Someone Happy pledge)

What buyers and brands see is the **Make Someone Happy pledge**: every purchase
comes with one. Partner shops add it through the **Pledge API**, and they send
**no customer data**: no order number, no name, no email. Partners see their
results only as numbers.

1. In `/lab` › **Partners**, an owner types the brand name (and, optionally, an
   email for the monthly report) and presses **Set up partner**. The page shows
   the partner ID, the key (`hfp_…`, shown once, only its hash is stored) and
   ready-to-paste code to send the partner. Partners can be switched off and
   their report email changed there.
2. When an order is paid, the shop's server asks for its pledge:

   ```
   POST /join/api/partners/pledges
   Authorization: Bearer hfp_…
   Idempotency-Key: <any value unique to the purchase, e.g. a random UUID>
   {}
   ```

   Answer: `{"pledge": "pl_…", "status": "open", "claimUrl"}`. The same
   Idempotency-Key gets the same pledge, so retries are safe. Sending `order`,
   `email` or other customer fields is refused (`400 no_customer_data`).
3. The shop shows `claimUrl` on its thank-you page or in its order email. It
   opens `/keep-your-pledge`; after signing in or creating a free account the
   pledge is the member's. A claimed link cannot be taken by someone else.
4. A cancelled or fully refunded purchase: `POST /join/api/partners/pledges/cancel`
   with `{"pledge": "pl_…"}` (the shop keeps our pledge reference only if it
   wants to cancel).
5. Numbers, never names: `GET /join/api/partners/report?month=YYYY-MM` gives
   `{month, given, claimed, kept, total}` (pledges given, kept by the buyer in
   an account, turned into an action). On the first day of each month partners
   with a report email get last month's numbers (Resend template
   `hf-partner-report`; variables `PARTNER`, `MONTH`, `GIVEN`, `CLAIMED`, `KEPT`,
   `TOTAL_GIVEN`, `TOTAL_CLAIMED`, `TOTAL_KEPT`).

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
