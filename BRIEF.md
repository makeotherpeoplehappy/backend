# Happiness Foundation backend: Build brief

Nov 15, 2026 · @Mickey

## Purpose and principles

One small backend on Webflow Cloud gives the Happiness Foundation site a shared place for data that no single member owns: Suggestions, stories, counts, pledges and invites. It is built in four phases, and each phase ships something members can use.

This brief is written for Claude Code. It covers what to build, the rules for every edge case agreed with Mickey, and the checks that define done. Nothing in it is built yet.

Every feature follows these rules:

- **The server decides.** Who is signed in and what they have done is checked on the server on every call. The browser is never trusted for identity.
- **Actions are identified by their Webflow CMS item ID**, never by page address. Addresses will change (`/actions/...` becomes `/action/...`).
- **The backend database is the source of truth.** The Webflow CMS holds the public copy that pages display.
- **Nothing a member sends is lost.** If Shopify or Webflow is briefly down, the request is queued and retried.
- **One click makes one record.** Double clicks and retries never create duplicates.
- **Pages render first.** Counts, stock and ripple numbers load afterwards and never block the page.
- **First names only** are ever shown to other members. Emails are never shown.
- **Native Webflow first.** The backend returns data; the site shows it in native Webflow elements styled with Style panel classes wherever possible. Where each kind of text lives (Webflow, Shopify, Resend, `src/wording/en.json`) is decided in the README, "Where text lives".

## What exists today

The site is a Webflow test site with Shopify behind it for accounts and the shop. All member data currently lives on each member's own Shopify customer record, written from the browser.

| Part | Detail |
| --- | --- |
| Webflow site | Happiness Foundation, site ID `6af7e827a9216ac8b164c1cb`, test address happiness-foundation.webflow.io |
| Shopify store | `r40e0y-zs.myshopify.com`, new customer accounts, Storefront Web Components cart |
| Sign-in | Shopify Customer Account API, run from the site through a global `HF` helper (`token`, `signin`, `finish`, `api`, `load`, `sync`, `signout`) |
| Done actions | Customer metafield `custom.actions_taken`, a JSON list of `{idea: <action slug>, date}` |
| Likes | Customer metafield `custom.action_votes`, JSON keyed by action slug with `{v: 1 or -1, d}` |
| Pledges | Shown on the account page by matching orders to later actions, in the browser |

Webflow CMS collections the backend reads or writes:

| Collection | ID | Fields that matter |
| --- | --- | --- |
| Actions | `6af7ebcaa5421969142eccae` | `name`, `slug`, `done-count`, `votes`, `do-it-with` (multi-reference), `suggestion` (reference to Suggestions), `hidden` |
| Suggestions | `6af8ab957991d4c1991814e9` | Idea text, submitter, `Status` (New, Approved, Rejected), `action` (reference to Actions) |
| Stories | `6af93db2a61504315554fd90` | `story`, `photo`, `video`, `action` (reference), `submitted-by`, `email`, `submitted-on`, `status` (New, Approved, Rejected), `review-notes` |
| Companions | `6af7ebc62c8c45967935cd43` | "On my own", "With kids", "With friends", "With colleagues" |
| Products, Drops | See the Webflow CMS | Drop quantity and lead product |

Pages that will call the backend: The action page ("I did this", like, "Do this with me", "Share your story"), `/account`, `/share-your-story`, `/do-this-with-me`, `/suggest-an-action`, `/stories`, the front page drop hero and the cart.

Two things to fix as part of the build:

- Done actions and likes are keyed by slug. Import them into the backend keyed by CMS item ID, then stop writing the metafields.
- The action page decides whether to show "Do this with me" by loading the whole action list. Replace that with one small backend call.

## Setup needed before the build

Six things must exist before any code can be deployed. The accounts and keys are Mickey's to set up; none of the keys go into a chat.

- [ ] A GitHub account and an empty repository for the backend.
- [ ] A Webflow Cloud app created from the Happiness Foundation site settings and connected to that repository.
- [ ] A Shopify app with read access to customers, orders, products and inventory, and write access to customers. Its key is stored in the Webflow Cloud app's settings.
- [ ] A Webflow API token for the site with CMS read and write access, stored the same way.
- [ ] An email sending service set up on the makeotherpeoplehappy.com domain. Webflow Cloud does not send email itself, as far as we know.
- [ ] Two environments: Test (the webflow.io site) and live, each with its own database, so test entries never reach the real site.

Webflow Cloud provides the three kinds of storage this build needs: A SQLite database for records, a key-value store for cached counts, and object storage for photos. Its cost at this usage and any plan limits have not been checked.

**Status on 15 November 2026**

- Webflow Cloud is available on the workspace, and the GitHub account is connected.
- The Webflow Cloud app "backend" exists on the site, connected to github.com/makeotherpeoplehappy/backend. Its live environment maps the branch main to the path /join, at happiness-foundation.webflow.io/join. The repository holds no app code yet, so there is no working deployment.
- The app is attached to the site and served from a path on the same domain. Use `/join`, so the site and the backend share one domain. It was chosen over a plain data path because invite links are served by the backend and people see the path in every link they share: www.makeotherpeoplehappy.com/join/k3x9. Data calls from the site use the same path.
- Keys and other secret values cannot be set through the Webflow connector. They are entered in the Webflow Cloud app's settings or with the Webflow command-line tool.
- Each environment maps one Git branch to one path. Use `main` for live and a `test` branch for the test site.

## Phase 1: Foundation

Every later phase depends on these parts, so they are built and tested first.

**Identity**

- Each call carries the member's Shopify customer token. The server verifies it with Shopify and reads the customer ID, first name and email from Shopify, never from the request.
- Calls are accepted only from the site's own domains.

**Resume after sign-in**

- A signed-out click on "I did this", "I'm in", "Share your story" or the like button is remembered and completed after sign-in. Today it is lost.
- After sign-up from an invite, the new member returns to the action they were invited to.
- If sign-in expires while a form is open, the typed text is kept and the member is asked to sign in again.

**Safety**

- Daily limits per member: 5 suggestions, 5 stories, 20 invites, 10 "done" marks.
- Bot protection on every call that does not require sign-in.
- Every write carries a one-time key, so a retry never duplicates it.
- Writes to Webflow and Shopify go through a queue with retries and respect their rate limits.

**Email**

Four messages only, each with a notification setting the member can turn off:

1. Someone joined your invite (one daily summary, never one per person).
2. Your story was approved.
3. Your suggested action is live.
4. Your pledge is still open, sent once, 7 days after the order.

**Operations**

- Errors are emailed to Mickey with enough detail to act on.
- A member who deletes their account has their stories and name removed from the site. Counts stay, without the name.
- One-time import of existing done actions and likes from Shopify metafields, mapped from slug to CMS item ID.

## Phase 2: Suggestions

A suggestion goes straight into the Suggestions collection for review, and approving it creates a draft action. Mickey reviews in the Webflow CMS; there is no separate admin dashboard.

1. A signed-in member sends an idea from `/suggest-an-action`. The server saves it and creates a Suggestions item with Status "New", the member's first name and their email.
2. The server compares the idea with existing action titles and earlier suggestions, and writes any close matches into the review notes.
3. Mickey sets Status to "Approved" or "Rejected" in the CMS.
4. On "Approved", the server creates a draft action with the idea as the working title and the `suggestion` reference set, and sets the suggestion's `action` reference to that draft.
5. Mickey completes the draft and publishes it.
6. On publish, the member gets the "Your action is live" email, and the action page shows "Suggested by \[first name\]".

Edge cases:

- "Approved" switched off and on again still yields one draft action.
- "Rejected" sends no email.
- A draft that is deleted before publishing clears the suggestion's `action` reference.
- A member who deletes their account keeps the action live; "Suggested by" is removed.
- Status changes are picked up by a Webflow webhook, with a check every 15 minutes as a fallback.

## Phase 2: Stories

A member can share one story for each action they have marked done, with text, a photo, a video link or any mix of the three. Each story is reviewed before it appears.

**Sending a story**

- Reached only from a done action: The action page, the account, or `/share-your-story?action=...`. The server confirms the member has done that action.
- One story per member per action. An empty story is blocked.
- Photo: Uploaded to object storage, up to 10 MB, common phone formats converted, resized for the web, and location data stripped from the file.
- Photo description: A short text field for screen readers. If left empty, a default such as "Photo from \[first name\]'s story" is used.
- Video: A link only, from YouTube, TikTok, Instagram or Vimeo. Vertical clips are shown as vertical players, muted by default.
- "With" line: Lists only members who tapped "I'm in" on this member's invite for this action. No free-typed names.
- Name: First name by default, with an option to post without a name.
- Consent: A required tick box, "Everyone shown has agreed to this".

**Review and publishing**

- A new story becomes a Stories item with Status "New", not published.
- "Approved" publishes it and sends the "Your story was approved" email. "Rejected" sends nothing.
- Editing an approved story sends it back to "New" and takes it off the site until re-approved.
- A member can delete their own story at any time, which removes it from the site at once.

**Where stories show**

- `/stories`, newest first, in pages of 20.
- On the action's own page, under the action.
- Each story has a "Report this story" link that emails Mickey.

**Edge cases**

- The action is later removed: The story stays and shows the action's name without a link.
- The video is later deleted by its host: The story shows without it.
- The member undoes the action: Not allowed while a story is attached. They delete the story first.

## Phase 3: Counts

Each action gets one shared "done" count that every member's click updates, shown only once it reaches 10.

**Marking an action done**

- "I did this" records the action for the signed-in member, with the date.
- "I did this again" is allowed, at most once a day per action.
- The public count shows people: "214 people have done this". A member counts once per action, however often they repeat it.
- The member's own tally ("People you have made happy") counts every time.
- Undo is allowed at any time, unless a story is attached. Counts adjust.

**Showing counts**

- A count appears on the action page only at 10 or more.
- "Most done" is a ranked list of actions at or above 10. It is hidden until at least 5 actions qualify.
- The page loads first and the live number follows. The number is also written to the action's `done-count` field once a day, so it is in the page for search engines.

**Likes**

- One positive click per member per action, which can be undone. "Don't like this" is removed from the page.
- Likes are private. They are written to the action's `votes` field once a day for Mickey to see which actions to improve or remove, and are not shown to visitors.
- Existing "don't like" records are imported as a private signal and kept out of the public site.

**Edge cases**

- An action is removed: Its done records stay in each member's history, shown by the title saved at the time.
- A member deletes their account: Their marks stay in the totals without their name.
- The action list or search page shows no count for actions below 10.

## Phase 3: Pledges and stock

The drop hero shows true numbers: How many pieces are left, how many pledges were made, and how many were kept.

**Pledges**

- One pledge per piece sold, taken from Shopify orders. An order of two pieces is two pledges.
- Cancelled and refunded pieces come out of the count.
- A pledge is kept when the buyer marks an action done after the order date. One action keeps one pledge, oldest open pledge first. Actions done before the purchase do not count.
- An order placed without an account links to the member when that email later signs in. Until then the pledge counts as made, not kept.
- The hero shows "100 pledges made, 64 kept" per drop. The account page shows each pledge as open or kept, with the action that kept it.
- One reminder email if a pledge is still open 7 days after the order. Never a second one.

**Stock**

- "X of 100 left" reads Shopify inventory for the drop's lead product, with all sizes added together. The total comes from the drop's quantity in the CMS.
- The number is cached for up to 60 seconds.
- At zero, the hero switches to its sold-out state.
- If inventory is not tracked for the product, the line is hidden.

**Known limit**

- The pledge tick box is enforced on the site only. Blocking checkout itself until the box is ticked needs Shopify's top plan, so the backend records pledges but cannot enforce them.

## Phase 4: Ripple

Invites, "I'm in", notifying the inviter and pass-it-on chains are one mechanic: A record of one member's action leading to another's. The member sees it as "Your actions led to 7 more".

**How it works**

1. A member taps "Do this with me" (actions that can be done with others) or "Pass it on" (any action, after marking it done). The server creates an invite with a random code.
2. The link is `/do-this-with-me?i=<code>`. It carries no name. The link people actually share is the backend address /join/\<code>: The backend answers it with the preview title and image, then sends the visitor on to this page, which asks the server for the inviter's first name and the action. Confirm in this phase how Webflow Cloud serves link previews; it has not been tested.
3. The phone's own share options open with the text and link. On a computer, the link is copied.
4. The invitee opens it, sees "\[First name\] wants to do this with you" and taps "I'm in". If signed out, they sign up or sign in and return to the same action.
5. The join is saved. The inviter's account shows "\[First name\] is in", and the daily summary email goes out.
6. When the invitee marks any action done after joining, it counts toward the inviter's ripple, and toward everyone above them in the chain.

**Rules**

- A member with no first name is asked for one before their first share.
- Opening your own invite shows "This is your invite" with a share button.
- Each member has one inviter. If two people invite the same person, the first invite they accept gets the credit.
- No loops: If A invited B, B's invite to A does not change A's inviter, and nothing is counted twice.
- "I'm in" without ever doing an action shows as joined and adds nothing to "led to".
- Doing the action together gives no automatic credit. Each person marks their own, and the page shows "Done together with \[first name\]".
- A joiner can leave an invite. Each side sees first names only.
- If the action is removed, the invite page says so and suggests three others.
- The share area carries one line: "Invite someone to do it with you, not the person you are doing it for."

**Sharing**

- When an invite or story link is pasted into a message, the preview shows a proper title and image. The server provides these for `/do-this-with-me` and for each story.
- After marking an action done, the member is offered a share card: "I made someone happy today", with their ripple number once it is above zero.

**Deferred, and why the data model allows for them**

- Team goals are not built. An invite can later carry a team ID without changing the tables.

## Requirements across everything

These apply to every phase and are part of done.

**Speed**

- No backend call blocks the first view of a page.
- A read call answers in under 300 ms for a typical visitor; counts and stock are served from cache.
- The action page makes one call that returns everything it needs: Done state, count, like state, whether it can be done with others, and stories.

**Accessibility**

- Every button and form the backend powers works by keyboard and is announced correctly by a screen reader.
- Every story photo has a description.
- Error and success messages appear as text next to the control, not only as colour.
- Emails are readable as plain text.

**Privacy**

- Only what a feature needs is stored. No email addresses of people who are not members.
- Photo files have location data removed.
- A member can see, export and delete their own data.
- EU rules apply, since Copenhagen is a launch city. Terms, a privacy policy and a minimum age are needed before launch and need a lawyer.

**Reliability**

- Dates are stored in UTC and shown in the visitor's local time.
- Test and live data are separate.
- Each phase ships with automated tests for its edge cases, listed under Acceptance checks.

## Data model

Ten tables in the SQLite database hold everything. Names are proposals; Claude Code may adjust them as long as the rules above hold.

| Table | What one row is | Key fields |
| --- | --- | --- |
| `members` | A Shopify customer who has used the site | Shopify customer ID, first name, notification settings, inviter (member ID, set once), created date |
| `actions` | A mirror of a Webflow action | CMS item ID, current slug, current title, can be done with others, published or removed |
| `done_marks` | One time a member did an action | Member, action, date, action title at the time |
| `likes` | A member's like on an action | Member, action, value, date |
| `suggestions` | An idea a member sent | Member, text, status, CMS item ID, draft action ID, similar-to notes |
| `stories` | A member's story for an action | Member, action, text, photo key, photo description, video link, show name or not, status, CMS item ID |
| `story_with` | A person named on a story's "with" line | Story, member |
| `invites` | A share link | Code, inviter, action, kind ("with me" or "pass it on"), team ID (unused for now), created date |
| `invite_joins` | A member who tapped "I'm in" | Invite, member, joined date, left date |
| `pledges` | One piece sold | Shopify order ID and line, drop, buyer email, member (when known), status (open, kept, cancelled), kept-by done mark, reminder sent date |

Supporting data:

- A queue table for writes to Webflow and Shopify that are waiting or being retried.
- A table of one-time request keys, so a retry is recognised.
- The key-value store holds cached counts per action, stock per drop and ripple totals per member.
- Object storage holds story photos, under keys that cannot be guessed.

## How the site calls the backend

The site makes a small number of calls, each returning plain data for native Webflow elements to show. "Member" means a verified Shopify sign-in is required.

| Call | Who | What it does |
| --- | --- | --- |
| Get action state | Anyone | For one action: Count (if 10 or more), can be done with others, approved stories. For a member also: Done or not, last done date, like state |
| Mark done | Member | Records a done mark; returns the new tally and count |
| Undo done | Member | Removes the latest mark, unless a story is attached |
| Set like | Member | Sets or clears the like |
| Get my account | Member | Tally, done actions with titles and dates, stories and their status, pledges open and kept, who joined my invites, ripple total |
| Send suggestion | Member | Saves the idea and creates the CMS item |
| Get upload address | Member | Returns a one-time address for a photo upload |
| Send story | Member | Saves or edits the story for a done action |
| Delete story | Member | Removes the story from the site and the database |
| Report story | Anyone | Emails Mickey; bot protected |
| Create invite | Member | Returns the share link and text |
| Get invite | Anyone | Inviter's first name, action title and short description, and whether the action is still live |
| Join invite | Member | Records "I'm in" |
| Leave invite | Member | Records leaving |
| Get drop state | Anyone | Pieces left, pledges made and kept for one drop |
| Get most done | Anyone | Ranked actions at or above 10 |
| Update settings | Member | First name for sharing, notification settings |
| Delete my data | Member | Removes the member's stories, name and records |

Incoming from other systems:

- Webflow webhooks: A CMS item changed in Suggestions, Stories or Actions.
- Shopify webhooks: Order created, cancelled or refunded; customer deleted.
- Scheduled jobs: Daily count write to the CMS, daily invite summary email, 7-day pledge reminder, 15-minute status check.

## Acceptance checks

A phase is done when every check below passes on the test site, at desktop, tablet (800) and phone (375) widths, signed in and signed out.

**Phase 1: Foundation**

- [ ] A call with a forged or expired token is refused.
- [ ] A signed-out click on "I did this" completes after sign-in, on the same action.
- [ ] A double click on any button creates one record.
- [ ] With Webflow's API switched off in a test, a submission is saved and appears once it is back.
- [ ] The sixth suggestion in a day is refused with a clear message.
- [ ] Existing done actions and likes for the test account appear after the import, on the right actions.
- [ ] Deleting a test member removes their stories and name; counts are unchanged.

**Phase 2: Suggestions and stories**

- [ ] A sent suggestion appears in the Suggestions collection as "New" within a minute.
- [ ] "Approved" creates exactly one draft action, even when toggled twice.
- [ ] Publishing that action sends one email and shows "Suggested by".
- [ ] A story cannot be sent for an action the member has not done, even by calling the server directly.
- [ ] An uploaded phone photo has no location data and loads in under a second.
- [ ] A TikTok or Shorts link shows as a vertical, muted player.
- [ ] "Approved" publishes the story on `/stories` and on the action page; editing it takes it down again.
- [ ] The story form and its messages work by keyboard alone.

**Phase 3: Counts, pledges and stock**

- [ ] An action with 9 marks shows no count; the tenth person makes it appear.
- [ ] "I did this again" twice in one day is refused the second time.
- [ ] Undo lowers the tally and the count, and is refused when a story is attached.
- [ ] A test order of two pieces makes two pledges; refunding one removes one.
- [ ] An action done after the order marks the oldest open pledge kept.
- [ ] The reminder is sent once at 7 days and never again.
- [ ] "X of 100 left" matches Shopify within 60 seconds and switches to sold out at zero.

**Phase 4: Ripple**

- [ ] The share link contains a code and no name.
- [ ] A new person taps "I'm in", signs up and lands on the invited action.
- [ ] The inviter's account shows the joiner's first name.
- [ ] Twenty joins in a day produce one email.
- [ ] A invites B and B invites A: Totals are counted once.
- [ ] The invite link shows a proper title and image when pasted into Messages and WhatsApp.
- [ ] An invite to a removed action shows the "no longer available" page with three suggestions.

## Out of scope and deferred

Seven things were considered and left out of this build.

| Item | Decision | Reason |
| --- | --- | --- |
| Affiliate program | Use an existing Shopify affiliate app | Custom tracking and payouts is a product of its own |
| "Remind me" before a drop | Use Shopify's own email sign-up and email tool | No custom code needed |
| Pre-drop lock | Check Shopify's native scheduled release first | May need no backend |
| Admin dashboard | Not built | The Webflow CMS with its Status field is the review screen |
| Team goals | Deferred | Needs team admins and privacy rules, and no teams exist yet |
| Automatic product sync | Deferred | A few products per drop; syncing on request takes minutes |
| Video file uploads | Not built | Hosting and reviewing video files costs the most for the least gain; links are used |

Also not in this build: A natural-language search box ("something nice for my mum, under $10"), and blocking checkout until the pledge is ticked.

## Open questions and choices to validate

These are not settled. The first group blocks the build; the second can be decided while it runs.

**Blocking**

- [ ] Is Webflow Cloud available on the site's plan, and what does it cost at this usage?
- [ ] Which email service sends the four messages?
- [ ] Who creates the GitHub repository and the Shopify app, and when?

**Choices worth a second look**

- [ ] **"People you have made happy" counts one per action.** Some actions reach many people (breakfast for a team). The Actions collection has a "how many" field. Should the tally use it?
- [ ] **Ripple counts forever.** Every action a joiner ever takes adds to the inviter's number. A window, such as the first 90 days, would keep the number meaningful. Which is it?
- [ ] **Two share buttons.** "Do this with me" and "Pass it on" may be one button too many on the action page. Test with a few people before keeping both.
- [ ] **Self-reported actions.** Nothing proves an action happened. The daily cap limits abuse. Is that enough for public counts and "pledges kept"?
- [ ] **Review workload.** Every suggestion and story waits for Mickey. Who reviews when volume grows, and within how many days?
- [ ] **The 7-day pledge reminder.** Confirm with a lawyer that it can be sent without marketing consent.
- [ ] **Stories and the CMS item limit.** Approved stories live in the Webflow CMS. Check the plan's item limit against expected volume.

**Needed for launch, outside the build**

- [ ] Terms and a privacy policy covering member photos, stories and names, including EU rules.
- [ ] A minimum age for accounts and stories.
- [ ] The `/actions` to `/action` address rename on the Webflow site.
