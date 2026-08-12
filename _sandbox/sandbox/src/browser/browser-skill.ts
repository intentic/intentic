// The CORE half of a browser capability: the note that teaches the agent to drive the one Chromium every
// platform shares. What a platform IS — its card, its login URL, its cheatsheet — is data in an installed
// extension's `contributes.capabilities` (see capabilities/contributions.ts), because that is the part that
// varies. Chromium itself (+ Xvfb, its headed virtual display) is the `browser` feature pack
// (packs/browser.Dockerfile): baked in the standard image, riding the environment overlay on a core one —
// the handler resolves it via environment/packs.ts.

// How to drive the browser well — shared by every variant below, because the mechanics of a snapshot and the
// publicness of a post do not depend on whose cookies the profile holds.
const DRIVING = (prefix: string): string => `
You drive a REAL browser through your Playwright tools (\`mcp__${prefix}__browser_navigate\`,
\`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_press_key\`, \`browser_take_screenshot\`,
\`browser_wait_for\`, …) over a persisted profile — once it is signed in, you act as the owner. Prefer
\`browser_snapshot\` (the accessibility tree) to find elements by role + visible text over guessing selectors;
screenshot when a page is visual or a snapshot is ambiguous. Work in small steps: navigate → snapshot → act →
re-snapshot to confirm. Posts, replies, votes, follows and joins are REAL and public — confirm the exact
target before you submit.`;

// The human-only escape hatch and the landing attestation — the tail of every playbook, identical on purpose:
// where a sign-in gets stuck and how it is declared finished do not vary with how the account came to exist.
const STUCK_AND_DONE = `
- Stuck on something only a person can clear — a captcha, a phone check, a password nobody stored? Call
  \`mcp__accounts__request_help\` with a precise ask. The owner sees your message over the live view of this
  browser, takes control, fixes that step and hands back; re-check the page state when the call returns.
- Signed in and sure of it (you see the site as the account, not a login page)? Call
  \`mcp__accounts__mark_connected\` so future turns open this browser already authenticated.`;

/* Substituted for a platform skill's `${tools}` — how to use the browser tools well and safely, plus the
 * connect playbook. Core, not per-platform data: the same lines duplicated into every pack are lines that
 * drift. `\${id}` is substituted after this note lands (contributedSkill), so the skill names the account it
 * belongs to.
 *
 * TWO VARIANTS, ONE SEAM, decided by whether the account names an identity — because the two kinds of account
 * genuinely differ in the one fact this note exists to carry: WHOSE BROWSER the account lives in.
 *
 *   standalone — the account owns its profile; its browser tools carry its own id, and connecting it walks the
 *                credential path (stored password, email codes read from whatever inbox is connected).
 *   identity   — the account lives in its identity's browser, beside the identity's own signed-in email. So
 *                its browser tools carry the IDENTITY's id, "Continue with <provider>" is the preferred door
 *                (the session that makes it one click is right there in the same profile), and confirmation
 *                codes come from the narrow \`fetch_email_code\` tool rather than a whole inbox.
 *
 * The account paragraph is not decoration: one site can be connected several times over (reddit-work,
 * reddit-personal), each a separate account with its own skill file rendered from the very same pack. Nothing
 * else in this skill would tell the agent which of them it is holding, and the failure that follows — a post
 * from the wrong account — is public and not undoable. */
export const browserToolsNote = (identity?: { readonly id: string; readonly email: string }): string =>
    identity === undefined
        ? `${DRIVING("${id}")}

CONNECTING THIS ACCOUNT is a job you can do yourself — when the account is still pending, or when you land on a
login screen because the session expired. Only when the owner asked for it; never sign up anywhere unprompted.
The playbook:
- Sign IN: open the login page. For a stored credential, click the field, then call
  \`mcp__accounts__type_credential\` — the daemon types the stored username or password for you; you never see a
  password and must never ask the owner to paste one into chat. Email codes and magic links you handle yourself:
  if an email inbox is connected (the IMAP skill), search it for the site's mail and open confirmation links IN
  THIS ACCOUNT'S browser (not the plain web one), so the confirmation lands in this profile.
- Sign UP: prefer passkey enrollment (the sandbox holds this account's own security key — "add a security key"
  just works) and email-code flows. When the site wants a password created, call
  \`mcp__accounts__create_password\` (generates and STORES it on the account's card), then type it into the form
  with \`type_credential\` — twice for a confirm field.${STUCK_AND_DONE}

THIS SKILL IS ONE ACCOUNT: \`\${id}\` — it is the \`account\` every accounts tool takes. Its browser tools open
that account's own browser and no other. The owner may have connected the same site more than once — each
account is a separate skill with its own tools — so act with the one they meant, ask when it is ambiguous, and
never carry a task from one account's tools into another's.`
        : `${DRIVING(identity.id)}

THIS ACCOUNT BELONGS TO THE IDENTITY \`${identity.id}\` (${identity.email}) and lives in ITS browser — the
\`mcp__${identity.id}__browser_*\` tools — beside the identity's own signed-in email and its other accounts.
One profile, one set of cookies, like a person's own browser.

CONNECTING THIS ACCOUNT is a job you can do yourself — when the account is still pending, or when you land on a
login screen because the session expired. Only when the owner asked for it; never sign up anywhere unprompted.
The playbook, in order of preference:
- SSO FIRST: on the site's login or signup page, look for "Continue with" the identity's own provider — that
  session already lives in this browser, so it is one click, no password, no email round-trip.
- Email flows: the account's address is the identity's email. Focus the email field and call
  \`mcp__accounts__type_credential\` (field "username") — the daemon types it. When the site wants a password
  created, call \`mcp__accounts__create_password\` (generates and STORES it on the account's card), then type it
  with \`type_credential\` — twice for a confirm field. Prefer passkey enrollment when offered (the identity
  holds its own security key — "add a security key" just works).
- Confirmation codes and links: call \`mcp__accounts__fetch_email_code\` — it returns the newest code or
  confirmation link the identity's mailbox received for this site, and nothing else. Open confirmation links in
  THIS browser, so they land in this profile. If no mailbox is linked, open the identity's own webmail in this
  browser and read just that mail.${STUCK_AND_DONE}

THIS SKILL IS ONE ACCOUNT: \`\${id}\` — it is the \`account\` every accounts tool takes, even though its browser
tools carry the identity's id. The owner may have connected the same site more than once — each account is a
separate skill — so act with the one they meant, ask when it is ambiguous, and never carry a task from one
account's tools into another's.`;

/* THE IDENTITY'S OWN SKILL — rendered by the identity handler into .agents/skills/<id>, the way a platform
 * card's skill is for an account. A platform skill teaches a SITE; this teaches a SOMEONE: which email the
 * sandbox is when it wears this identity, whose browser that is, and what it may do about accounts that do not
 * exist yet. It exists even when the identity has no accounts at all — that is precisely the moment it matters,
 * because the browser tools it names are how the first account gets opened.
 *
 * The open-accounts paragraph is decided at APPLY time from the card's switch. Prose, not enforcement — the
 * \`open_account\` tool re-checks the switch on every call — but the honest skill keeps the agent from walking
 * into a refusal it was never going to get past. */
export const identitySkill = (id: string, email: string, openAccounts: boolean): string => `---
name: ${id}
description: The sandbox's online identity "${id}" — ${email} and its signed-in browser. Use it to act as this identity on the web, read its webmail, and connect platform accounts through it.
---

# Identity: ${id} — ${email}

One someone this sandbox is online. Its browser (\`mcp__${id}__browser_*\`) is a single persisted profile
holding the identity's email session and every account born from it — sites see one consistent person, and a
"Continue with" button for its provider is one click because that session is right here.
${
    openAccounts
        ? `
OPENING ACCOUNTS: the owner allows this identity to open platform accounts on its own. Check
\`mcp__accounts__roster\` FIRST — it says which accounts this identity (and every other one you speak for)
already holds, so "prefer joining over creating" is a decision you can actually make rather than a hope. When
the site is genuinely new, call \`mcp__accounts__open_account\` (an account id, the site, and one line on what
it is for) — it files the account under this identity, and works for any site, carded or not — then perform the
signup in this browser, SSO first, and tell the owner what you opened and why.

FILING IS PART OF SIGNING UP. That entry is the only record the account exists: nothing else knows, and a
session months from now asking "do we already have one here" is asking the roster. So open the account before
you fill the form, never from memory afterwards, and never write the fact down anywhere else.`
        : `
OPENING ACCOUNTS: the owner has NOT allowed this identity to open accounts on its own — the switch on its card
is off. Connect only accounts the owner explicitly asked for, and ask before any signup.`
}

- The identity's email is \`${email}\`; the daemon types it (and its stored email password, if any) via
  \`mcp__accounts__type_credential\` with account "${id}" — you never read a password.
- Codes and confirmation links its mailbox received: \`mcp__accounts__fetch_email_code\`.
- Its webmail, when a mail needs real reading: open the provider in THIS browser — it is already signed in.
- Stuck on a human-only step (a captcha, a phone check, a provider re-challenge): \`mcp__accounts__request_help\`
  with a precise ask; the owner steps into this browser, clears it, and hands back.
- Signed the identity itself into its provider and sure of it? \`mcp__accounts__mark_connected\` (account "${id}").
${DRIVING(id)}`;
