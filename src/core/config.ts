// Fixed IDs from the Happiness Foundation Webflow site. These are not
// secrets; keys and tokens are read from environment variables (see env.ts).

/** The foundation site's Memberstack app (public ID; tokens from other apps are refused). */
export const MEMBERSTACK_APP_ID = 'app_cmwkphy3a00030ste4jkeglrs';
/** The free "Active" and "Inactive" plans in Memberstack (test mode). Not secrets. */
export const MEMBERSTACK_ACTIVE_PLAN_ID = 'pln_active-er8r0xp0';
export const MEMBERSTACK_INACTIVE_PLAN_ID = 'pln_inactive-un8s0xdg';

export const CMS = {
  siteId: '6af7e827a9216ac8b164c1cb',
  actions: {
    id: '6af7ebcaa5421969142eccae',
    // Companions item "On my own" (slug on-my-own). Any other companion in `do-it-with`
    // means the action can be done with others.
    onMyOwnCompanionId: '6af7edb79fddcb1ec5b3d86a',
    // "Who" items (who an action makes happy), by CMS item ID. The share card's
    // line is chosen by slug (wording keys card-who-<slug>).
    whoSlugs: {
      '6af7ec5177462bb643f480d7': 'partner',
      '6af7ec5177462bb643f480d9': 'child',
      '6af7ec5177462bb643f480db': 'parent',
      '6af7ec5177462bb643f480dd': 'grandparent',
      '6af7ec5177462bb643f480df': 'family',
      '6af7ec5177462bb643f480e1': 'friend',
      '6af7ec5177462bb643f480e3': 'colleague',
      '6af7ec5177462bb643f480e5': 'neighbor',
      '6af7ec5177462bb643f480e7': 'teacher',
      '6af7ec5177462bb643f480e9': 'someone-who-serves-you',
      '6af7ec5177462bb643f480eb': 'someone-having-a-hard-time',
      '6af7ec5177462bb643f480ed': 'stranger',
      '6af7ec5177462bb643f480ef': 'community',
    } as Record<string, string>,
    // "How many" options: people made happy per "I did this" (approved numbers).
    howManyPeople: {
      a08fe76af0a753998a24280bbaa61301: 1, // One person
      bc2e90809713a6449e2fe39b7cfc4679: 3, // A few people
      c846cbc88294372dd74bb375803f7e62: 8, // A group
      '56e007376964f22ad048c19233d89268': 25, // A whole community
    } as Record<string, number>,
  },
  suggestions: {
    id: '6af8ab957991d4c1991814e9',
    status: {
      new: 'd7a78fab32f7b46e869b35e5defb9a1c',
      approved: '81216ff344b4611fab68c246d167db27',
      rejected: 'e2e01c9b7f6584b7f9e65faca50e1773',
    },
  },
  /** Shop products, copied from Shopify by shop.ts (product pages at /product/<handle>). */
  products: {
    id: '6afe00a75969cf93ee81b0bc',
  },
  /** Drops (Shopify collections with a drop date), copied by shop.ts. */
  drops: {
    id: '6afe009d7ff9b83f1cac80fa',
  },
  stories: {
    id: '6af93db2a61504315554fd90',
    status: {
      new: '5f629e65be7a083ba5e64485cc1c3b50',
      approved: 'dbb245a3b1485dfd8c1e54b2ddfee490',
      rejected: '75cbbcd8089cdaed98ea7ee4b16accca',
    },
  },
} as const;

// Daily limits per member (UTC days).
export const LIMITS = {
  suggestion: 5,
  story: 5,
  invite: 20,
} as const;

export type LimitKind = keyof typeof LIMITS;

export const LIMIT_MESSAGES: Record<LimitKind, string> = {
  suggestion: 'err-limit-suggestion',
  story: 'err-limit-story',
  invite: 'err-limit-invite',
};

// The four member emails. Each has its own on/off setting.
export const EMAIL_KINDS = {
  invite_summary: 'notify_invite_summary',
  story_approved: 'notify_story_approved',
  suggestion_live: 'notify_suggestion_live',
  pledge_reminder: 'notify_pledge_reminder',
} as const;

export type EmailKind = keyof typeof EMAIL_KINDS;

// How many public "done" people an action needs before its count is shown.
export const COUNT_THRESHOLD = 10;

/** Hours before a drop's date when Active members can buy it (one of each piece). */
export const EARLY_ACCESS_HOURS = 24;
