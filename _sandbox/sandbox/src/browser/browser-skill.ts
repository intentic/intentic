// The CORE half of a browser capability: the note that teaches the agent to drive the one routed browser
// server every account shares. What a platform IS, its card, its login URL, its cheatsheet, is data in an
// installed extension's `contributes.capabilities` (see capabilities/contributions.ts), because that is the
// part that varies. Chromium itself (+ Xvfb, its headed virtual display) is the `browser` feature pack
// (packs/browser.Dockerfile): baked in the standard image, riding the environment overlay on a core one,
// the handler resolves it via environment/packs.ts.
//
// ONE SKILL PER KIND OF THING, NEVER PER ACCOUNT. These templates used to render once per connected account,
// one file per identity, one per account, each a clone of the same text with a different id, and the catalog
// paid per clone: a near-identical description line in every prompt for every account, on top of the
// per-account tool schemas the router has since collapsed (browser-tools.ts). Now the text teaches the
// MACHINERY once, and which accounts exist is DATA: a rendered roster block inside the one skill, plus the
// live `mcp__accounts__roster` tool. capabilities/account-skills.ts is the renderer.

import type { BrowserConfig, IdentityConfig } from "@intentic/sandbox-contract";

// How to drive the routed browser well, shared by the identities skill and every platform skill, because the
// mechanics of a snapshot and the publicness of a post do not depend on whose cookies the profile holds.
const DRIVING = `
You drive REAL browsers through the \`browser\` server's Playwright tools (\`mcp__browser__browser_navigate\`,
\`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_press_key\`, \`browser_take_screenshot\`,
\`browser_wait_for\`, …). EVERY CALL NAMES WHOSE BROWSER with its \`account\` argument: an account's id, or an
identity's id for the identity's own browser. Once a profile is signed in, you act as its owner. Prefer
\`browser_snapshot\` (the accessibility tree) to find elements by role + visible text over guessing selectors;
screenshot when a page is visual or a snapshot is ambiguous. Work in small steps: navigate → snapshot → act →
re-snapshot to confirm. Posts, replies, votes, follows and joins are REAL and public: confirm the exact
target AND the exact account before you submit, and never carry a task from one account into another's calls.`;

// The human-only escape hatch and the landing attestation, the tail of every playbook, identical on purpose:
// where a sign-in gets stuck and how it is declared finished do not vary with how the account came to exist.
const STUCK_AND_DONE = `
- Stuck on something only a person can clear: a captcha, a phone check, a password nobody stored? Call
  \`mcp__accounts__request_help\` with a precise ask. The owner sees your message over the live view of that
  browser, takes control, fixes that step and hands back; re-check the page state when the call returns.
- Signed in and sure of it (you see the site as the account, not a login page)? Call
  \`mcp__accounts__mark_connected\` so future turns open this browser already authenticated.`;

/* Substituted for a platform skill's `${tools}`, how to use the browser tools well and safely, plus the
 * connect playbook. Core, not per-platform data: the same lines duplicated into every pack are lines that
 * drift. ONE text for both kinds of account, because the kind is now a fact on the skill's roster line rather
 * than a fork in the template:
 *
 *   standalone, the account owns its profile, and connecting it walks the credential path (stored password,
 *                email codes read from whatever inbox is connected).
 *   identity-born, the account lives in its identity's browser beside the identity's own signed-in email, so
 *                "Continue with <provider>" is the preferred door and confirmation codes come from the narrow
 *                \`fetch_email_code\` tool rather than a whole inbox.
 *
 * The roster block (`${accounts}`) is not decoration: one site can be connected several times over
 * (reddit-work, reddit-personal), and the failure that follows from mixing them up, a post from the wrong
 * account, is public and not undoable. */
export const browserToolsNote = (): string => `${DRIVING}

THE ACCOUNTS ON THIS SKILL are listed above: each line is an \`account\` value the browser tools and every
\`mcp__accounts__*\` tool take. An account born of an identity shares that identity's browser (one profile, one
set of cookies, like a person's own browser), so its pages may equally be driven with the identity's id; a
standalone account owns its profile alone. Act with the account the owner meant, and ask when it is ambiguous.

CONNECTING AN ACCOUNT is a job you can do yourself, when it is still pending, or when you land on a login
screen because the session expired. Only when the owner asked for it; never sign up anywhere unprompted. The
playbook, in order of preference:
- IDENTITY-BORN, SSO FIRST: on the site's login or signup page, look for "Continue with" the identity's own
  provider: that session already lives in the shared browser, so it is one click, no password, no email
  round-trip.
- Email and credential flows: focus the field, then call \`mcp__accounts__type_credential\`, the daemon types
  the stored username (an identity-born account's is its identity's email) or password for you; you never see
  a password and must never ask the owner to paste one into chat. When the site wants a password created, call
  \`mcp__accounts__create_password\` (generates and STORES it on the account's card), then type it with
  \`type_credential\`: twice for a confirm field. Prefer passkey enrollment when offered (the profile holds
  its own security key: "add a security key" just works).
- Confirmation codes and links: for an identity-born account call \`mcp__accounts__fetch_email_code\`, it
  returns the newest code or confirmation link the identity's mailbox received for this site, and nothing
  else. For a standalone account, search whatever inbox is connected (the IMAP skill). Open confirmation links
  in the ACCOUNT'S OWN browser (the same \`account\` value), so they land in the right profile.${STUCK_AND_DONE}`;

/* One identity's roster line and one account's, the DATA half of the skills, rendered wherever the converge
 * puts `${accounts}` (capabilities/account-skills.ts). The backticked id leading each line is deliberate and
 * relied on: it is the exact `account` value the tools take, and it is what the handlers' status probes
 * look for to say an entry's apply has landed. */
const identityLine = (id: string, config: IdentityConfig): string => {
    const notes = [
        config.email,
        config.openAccounts === "on" ? "may open accounts on its own" : "may NOT open accounts on its own",
        ...(config.mailbox === undefined || config.mailbox === "" ? [] : [`mail read via \`${config.mailbox}\``]),
    ];
    return `- \`${id}\`: ${notes.join(" · ")}`;
};

export const accountSkillLine = (id: string, config: BrowserConfig, identityEmail?: string): string => {
    const homeUrl = config["homeUrl"];
    const notes = [
        config.identity === undefined || config.identity === ""
            ? "standalone (its own browser and profile)"
            : `born of the identity \`${config.identity}\`${identityEmail === undefined ? "" : ` (${identityEmail})`}, shares its browser`,
        ...(homeUrl === undefined || homeUrl === "" ? [] : [`opens on ${homeUrl}`]),
        ...(config.purpose === undefined || config.purpose === "" ? [] : [config.purpose]),
        ...(config.openedAt === undefined || config.openedAt === "" ? [] : [`opened ${config.openedAt}`]),
    ];
    return `- \`${id}\`: ${notes.join(" · ")}`;
};

/* THE IDENTITIES SKILL, one file for every someone this sandbox is online as, where there used to be a clone
 * per identity. A platform skill teaches a SITE; this teaches the identity machinery: whose browser an
 * identity is, which email it answers to, and what it may do about accounts that do not exist yet. It exists
 * even for an identity with no accounts at all, that is precisely the moment it matters, because the browser
 * tools it names are how the first account gets opened.
 *
 * The open-accounts guidance is decided per identity by its roster line, from the card's switch. Prose, not
 * enforcement, the `open_account` tool re-checks the switch on every call, but the honest skill keeps the
 * agent from walking into a refusal it was never going to get past. */
export const identitiesSkill = (identities: readonly { readonly id: string; readonly config: IdentityConfig }[]): string => {
    const ids = identities.map((identity) => identity.id);
    const anyOpen = identities.some((identity) => identity.config.openAccounts === "on");
    return `---
name: identities
description: The sandbox's online identities, the emails it acts as on the web, each with a signed-in browser its accounts share: ${identities
        .map((identity) => `${identity.id} (${identity.config.email})`)
        .join(", ")}. Use to act as one of them, read its webmail, or connect platform accounts through it.
---

# Identities: the someones this sandbox is online as

Each identity below is one persisted browser profile holding the identity's email session and every account
born from it: sites see one consistent person, and a "Continue with" button for its provider is one click
because that session is right there. Its id is the \`account\` value the browser tools and every
\`mcp__accounts__*\` tool take.

${identities.map((identity) => identityLine(identity.id, identity.config)).join("\n")}
${
    anyOpen
        ? `
OPENING ACCOUNTS: the owner allows the identities marked so above to open platform accounts on their own.
Check \`mcp__accounts__roster\` FIRST: it says which accounts every identity already holds, so "prefer joining
over creating" is a decision you can actually make rather than a hope. When the site is genuinely new, call
\`mcp__accounts__open_account\` (an account id, the site, the identity, and one line on what it is for): it
files the account under that identity, and works for any site, carded or not: then perform the signup in the
identity's browser, SSO first, and tell the owner what you opened and why.

FILING IS PART OF SIGNING UP. That entry is the only record the account exists: nothing else knows, and a
session months from now asking "do we already have one here" is asking the roster. So open the account before
you fill the form, never from memory afterwards, and never write the fact down anywhere else. An identity NOT
marked above refuses: connect only accounts the owner explicitly asked for there.`
        : `
OPENING ACCOUNTS: no identity here may open accounts on its own, the switch on every card is off. Connect
only accounts the owner explicitly asked for, and ask before any signup.`
}

- An identity's stored username IS its email; the daemon types it (and its stored email password, if any) via
  \`mcp__accounts__type_credential\` with the identity's id: you never read a password.
- Codes and confirmation links its mailbox received: \`mcp__accounts__fetch_email_code\`.
- Its webmail, when a mail needs real reading: open the provider in ITS browser, it is already signed in.
- Stuck on a human-only step (a captcha, a phone check, a provider re-challenge): \`mcp__accounts__request_help\`
  with a precise ask; the owner steps into that browser, clears it, and hands back.
- Signed an identity itself into its provider (${ids.map((id) => `"${id}"`).join(", ")}) and sure of it?
  \`mcp__accounts__mark_connected\` with its id.
${DRIVING}`;
};
