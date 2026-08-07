// The CORE half of a browser capability: the one Chromium every platform shares, and the note that teaches the
// agent to drive it. What a platform IS — its card, its login URL, its cheatsheet — is data in an installed
// extension's `contributes.capabilities` (see capabilities/contributions.ts), because that is the part that
// varies. These two do not: one install serves every platform, and the tools are the same wherever they point.

// One shared Dockerfile fragment for every browser platform — composeEnvironment dedupes identical fragment
// strings, so N browser capabilities add it exactly once. Chromium is NOT installed here: the base image bakes
// it, with the OS libraries `install --with-deps` pulls, at playwright's default cache path (see the
// Dockerfile's Chromium layer) — which is exactly what the daemon's `playwright` (guided login) and the agent's
// `@playwright/mcp` resolve via chromium.executablePath(). This fragment used to install a SECOND Chromium into
// PLAYWRIGHT_BROWSERS_PATH=/ms-playwright — including re-downloading the headless shell the base image deletes —
// so a browser-enabled sandbox carried ~650 MiB of duplicate browser and the rebuild spent minutes downloading
// what the image already had. Chromium launches with `--no-sandbox` (an app-level flag), so no
// `# intentic:runtime` directive / container privilege is required.
// xvfb is what actually rides the rebuild: Chromium must run HEADED on a virtual display — the headless shell is
// fingerprinted and blocked by anti-bot WAFs (e.g. Reddit's "network security"), whereas headed full Chromium
// under Xvfb looks like a real browser.
export const BROWSER_FRAGMENT = `# browser automation: Xvfb, the virtual display Chromium runs HEADED on so it isn't flagged as a headless bot.
# Chromium itself (+ its OS libraries) is already baked in the base image; only the display server rides the rebuild.
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \\
    && rm -rf /var/lib/apt/lists/*`;

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
