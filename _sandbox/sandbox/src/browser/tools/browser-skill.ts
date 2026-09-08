// Core skill for driving the routed browser; platform data (card, login, cheatsheet) is an extension's contribution.
// Chromium and Xvfb are the `browser` feature pack (image-packs/browser.Dockerfile), resolved via environment/packs.ts.
// One skill per kind, never per account: accounts are data, a roster block plus the live mcp__accounts__roster tool.

import type { BrowserConfig, IdentityConfig } from "@intentic/sandbox-contract";

// How many roster ids show before collapsing to a count; shared with account-skills.ts's tail.
const ROSTER_IDS_IN_DESCRIPTION = 4;
export const rosterSummary = (ids: readonly string[]): string =>
    ids.length <= ROSTER_IDS_IN_DESCRIPTION
        ? ids.join(", ")
        : `${ids.slice(0, ROSTER_IDS_IN_DESCRIPTION).join(", ")} and ${ids.length - ROSTER_IDS_IN_DESCRIPTION} more`;

// Shared driving guidance for identities and platform skills alike; same mechanics regardless of whose cookies.
const DRIVING = `
You drive REAL browsers through the \`browser\` server's Playwright tools (\`mcp__browser__browser_navigate\`,
\`browser_snapshot\`, \`browser_click\`, \`browser_type\`, \`browser_press_key\`, \`browser_take_screenshot\`,
\`browser_wait_for\`, …). BOTH TOOL FAMILIES ARE DEFERRED: before the first call, load them with ToolSearch,
\`+mcp__browser__\` for these and \`+accounts\` for the \`mcp__accounts__*\` tools named below. EVERY CALL NAMES
WHOSE BROWSER with its \`account\` argument: an account's id, or an
identity's id for the identity's own browser. Once a profile is signed in, you act as its owner. Prefer
\`browser_snapshot\` (the accessibility tree) to find elements by role + visible text over guessing selectors;
screenshot when a page is visual or a snapshot is ambiguous. Work in small steps: navigate → snapshot → act →
re-snapshot to confirm. Posts, replies, votes, follows and joins are REAL and public: confirm the exact
target AND the exact account before you submit, and never carry a task from one account into another's calls.`;

// Shared tail of every playbook: how a stuck sign-in escalates and how it's declared done, regardless of origin.
const STUCK_AND_DONE = `
- Stuck on something only a person can clear: a captcha, a phone check, a password nobody stored? Call
  \`mcp__accounts__request_help\` with a precise ask. The owner sees your message over the live view of that
  browser, takes control, fixes that step and hands back; re-check the page state when the call returns.
- Signed in and sure of it (you see the site as the account, not a login page)? Call
  \`mcp__accounts__mark_connected\` so future turns open this browser already authenticated.`;

// Substituted for a platform skill's `${tools}`: one text for both account kinds, since the kind is now a fact on the
// roster line, not a template fork.
// `${accounts}` matters because one site can be connected multiple times (reddit-work, reddit-personal), and posting
// from the wrong one is public and permanent.
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

// Roster line data for one identity or account, rendered into `${accounts}` (capabilities/account-skills.ts).
// The leading backticked id is the exact `account` value tools take, and what status probes match on.
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

// One skill for every identity this sandbox is online as: what browser it shares, which email it answers to, and what
// it may do about accounts that don't exist yet.
// Open-accounts guidance is prose per roster line; open_account re-checks the switch itself, this just avoids walking
// the agent into a refusal.
export const identitiesSkill = (identities: readonly { readonly id: string; readonly config: IdentityConfig }[]): string => {
    const ids = identities.map((identity) => identity.id);
    const anyOpen = identities.some((identity) => identity.config.openAccounts === "on");
    return `---
name: identities
description: The sandbox's online identities (${rosterSummary(ids)}), the e-mail addresses it acts as on the web, each with a signed-in browser its accounts share. Use to act as one of them, read its webmail, or connect platform accounts through it; the roster inside lists every id and address.
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
