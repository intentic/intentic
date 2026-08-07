// The CORE half of a browser capability: the note that teaches the agent to drive the one Chromium every
// platform shares. What a platform IS — its card, its login URL, its cheatsheet — is data in an installed
// extension's `contributes.capabilities` (see capabilities/contributions.ts), because that is the part that
// varies. Chromium itself (+ Xvfb, its headed virtual display) is the `browser` feature pack
// (packs/browser.Dockerfile): baked in the standard image, riding the environment overlay on a core one —
// the handler resolves it via environment/packs.ts.

// Substituted for a platform skill's `${tools}` — how to use the browser tools well and safely. Core, not
// per-platform data: the same eight lines duplicated into every pack is eight lines that drift.
export const BROWSER_TOOLS_NOTE = `
You drive a REAL logged-in browser through your Playwright tools (\`browser_navigate\`, \`browser_snapshot\`,
\`browser_click\`, \`browser_type\`, \`browser_press_key\`, \`browser_take_screenshot\`, \`browser_wait_for\`, …). The
session is already signed in as the owner — you act as them. Prefer \`browser_snapshot\` (the accessibility tree)
to find elements by role + visible text over guessing selectors; screenshot when a page is visual or a snapshot
is ambiguous. Work in small steps: navigate → snapshot → act → re-snapshot to confirm. If you hit a login/signup
screen the session has expired — stop and tell the owner to reconnect (Capabilities → this connector → Log in).
Posts, replies, votes, follows and joins are REAL and public — confirm the exact target before you submit.`;
