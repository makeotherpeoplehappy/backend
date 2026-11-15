// Fixed IDs from the Happiness Foundation Webflow site. These are not
// secrets; keys and tokens are read from environment variables (see env.ts).

export const CMS = {
  siteId: '6af7e827a9216ac8b164c1cb',
  actions: {
    id: '6af7ebcaa5421969142eccae',
    // Companions item "On my own" (slug on-my-own). Any other companion in `do-it-with`
    // means the action can be done with others.
    onMyOwnCompanionId: '6af7edb79fddcb1ec5b3d86a',
  },
  suggestions: {
    id: '6af8ab957991d4c1991814e9',
    status: {
      new: 'd7a78fab32f7b46e869b35e5defb9a1c',
      approved: '81216ff344b4611fab68c246d167db27',
      rejected: 'e2e01c9b7f6584b7f9e65faca50e1773',
    },
  },
  products: {
    id: '6af88f08848599f43fec76c8',
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
  done: 10,
} as const;

export type LimitKind = keyof typeof LIMITS;

export const LIMIT_MESSAGES: Record<LimitKind, string> = {
  suggestion: 'You can send 5 suggestions a day. Please try again tomorrow.',
  story: 'You can share 5 stories a day. Please try again tomorrow.',
  invite: 'You can create 20 invites a day. Please try again tomorrow.',
  done: 'You can mark 10 actions as done a day. Please try again tomorrow.',
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
