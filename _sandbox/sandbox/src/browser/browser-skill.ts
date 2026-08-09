// The CORE half of a browser capability: the note that teaches the agent to drive the one Chromium every
// platform shares. What a platform IS — its card, its login URL, its cheatsheet — is data in an installed
// extension's `contributes.capabilities` (see capabilities/contributions.ts), because that is the part that
// varies. Chromium itself (+ Xvfb, its headed virtual display) is the `browser` feature pack
// (packs/browser.Dockerfile): baked in the standard image, riding the environment overlay on a core one —
// the handler resolves it via environment/packs.ts.

/* Substituted for a platform skill's `${tools}` — how to use the browser tools well and safely. Core, not
 * per-platform data: the same eight lines duplicated into every pack is eight lines that drift.
 *
 * The account paragraph is here for the same reason, and it is not decoration: one site can be connected several
 * times over (reddit-work, reddit-personal), each a separate profile with its own tools and its own skill file
 * rendered from the very same pack. Nothing else in this skill would tell the agent which of them it is holding,
 * and the failure that follows — a post from the wrong account — is public and not undoable. `\${id}` is
 * substituted after this note lands, so the skill names the account it belongs to. */
export const BROWSER_TOOLS_NOTE = `
You drive a REAL browser through your Playwright tools (\`browser_navigate\`, \`browser_snapshot\`,
\`browser_click\`, \`browser_type\`, \`browser_press_key\`, \`browser_take_screenshot\`, \`browser_wait_for\`, …),
over this account's own persisted profile — once it is signed in, you act as the owner. Prefer
\`browser_snapshot\` (the accessibility tree) to find elements by role + visible text over guessing selectors;
screenshot when a page is visual or a snapshot is ambiguous. Work in small steps: navigate → snapshot → act →
re-snapshot to confirm. Posts, replies, votes, follows and joins are REAL and public — confirm the exact
target before you submit.

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
  with \`type_credential\` — twice for a confirm field.
- Stuck on something only a person can clear — a captcha, a phone check, a password nobody stored? Call
  \`mcp__accounts__request_help\` with a precise ask. The owner sees your message over the live view of this
  browser, takes control, fixes that step and hands back; re-check the page state when the call returns.
- Signed in and sure of it (you see the site as the account, not a login page)? Call
  \`mcp__accounts__mark_connected\` so future turns open this browser already authenticated.

THIS SKILL IS ONE ACCOUNT: \`\${id}\` — it is the \`account\` every accounts tool takes. Its browser tools open
that account's own browser and no other. The owner may have connected the same site more than once — each
account is a separate skill with its own tools — so act with the one they meant, ask when it is ambiguous, and
never carry a task from one account's tools into another's.`;
