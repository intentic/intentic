import type { BrowserPlatform } from "@intentic/sandbox-contract";

// The curated seam for browser-automation platforms: each maps to (1) the URL the guided login opens and (2) the
// SKILL.md dropped into .claude/skills/<id> so the agent knows it can drive that site and how. Every platform
// shares ONE Chromium install (BROWSER_FRAGMENT) — the agent acts through the @playwright/mcp browser tools, so
// a skill is goal-oriented prose, not selectors. Adding a platform is one entry here plus a BrowserPlatform
// variant — no new capability plumbing.
export interface BrowserProvider {
    readonly loginUrl: string;
    readonly skill: string;
}

// One shared Dockerfile fragment for every browser platform — composeEnvironment dedupes identical fragment
// strings, so N browser capabilities bake Chromium exactly once. Chromium is heavy, so (like whisper/psql) it
// rides the environment overlay applied on an owner rebuild, not the base image. `--with-deps` pulls the apt
// libraries Chromium needs; PLAYWRIGHT_BROWSERS_PATH pins one location the daemon's `playwright` (guided login)
// AND the agent's `@playwright/mcp` both resolve. Chromium launches with `--no-sandbox` (an app-level flag), so
// no `# intentic:runtime` directive / container privilege is required.
// xvfb is added so Chromium can run HEADED on a virtual display — the headless shell is fingerprinted and blocked
// by anti-bot WAFs (e.g. Reddit's "network security"), whereas headed full Chromium under Xvfb looks like a real
// browser. Chromium's own libraries come from `playwright install --with-deps`.
export const BROWSER_FRAGMENT = `# browser automation: Chromium (+ OS libraries) and Xvfb for a virtual display, so the browser runs HEADED and
# isn't flagged as a headless bot. Drives both the guided login and the agent's @playwright/mcp.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
RUN apt-get update && apt-get install -y --no-install-recommends xvfb \\
    && cd /opt/sandbox && node node_modules/playwright/cli.js install --with-deps chromium \\
    && rm -rf /var/lib/apt/lists/*`;

// Shared closing guidance appended to every platform skill — how to use the browser tools well and safely.
const TOOLS_NOTE = `
You drive a REAL logged-in browser through your Playwright tools (\`browser_navigate\`, \`browser_snapshot\`,
\`browser_click\`, \`browser_type\`, \`browser_press_key\`, \`browser_take_screenshot\`, \`browser_wait_for\`, …). The
session is already signed in as the owner — you act as them. Prefer \`browser_snapshot\` (the accessibility tree)
to find elements by role + visible text over guessing selectors; screenshot when a page is visual or a snapshot
is ambiguous. Work in small steps: navigate → snapshot → act → re-snapshot to confirm. If you hit a login/signup
screen the session has expired — stop and tell the owner to reconnect (Capabilities → this connector → Log in).
Posts, replies, votes, follows and joins are REAL and public — confirm the exact target before you submit.`;

const REDDIT_SKILL = `---
name: reddit
description: Read, comment, reply, vote, post, and join subreddits on Reddit as the logged-in user, through a real browser. Use whenever the user asks to do something on Reddit.
---

# Reddit (connected browser)

Feed: https://www.reddit.com  ·  subreddit: https://www.reddit.com/r/<name>  ·  inbox:
https://www.reddit.com/message/inbox  ·  submit: https://www.reddit.com/submit

- Read a subreddit or thread: navigate, then \`browser_snapshot\` to read posts and comments.
- Comment / reply: open the post, find the Reply box, \`browser_type\`, then submit.
- Vote: click the upvote/downvote control on a post or comment.
- Create a post: subreddit → Create Post (or /submit) → fill title + body → pick the community → Post.
- Join a community: open the subreddit and click Join.
${TOOLS_NOTE}
`;

const X_SKILL = `---
name: x
description: Read, reply, post, like, repost, follow, and join Communities on X (Twitter) as the logged-in user, through a real browser. Use whenever the user asks to do something on X/Twitter.
---

# X / Twitter (connected browser)

Home: https://x.com/home  ·  compose: https://x.com/compose/post  ·  profile: https://x.com/<handle>  ·
Communities: https://x.com/i/communities  ·  notifications: https://x.com/notifications

- Read the timeline or a thread: navigate, then \`browser_snapshot\`.
- Reply: open the post → Reply → \`browser_type\` → Post.
- New post: go to compose → type → Post.
- Like / repost: click the like or repost control on the post.
- Follow: open the profile and click Follow.
- Join a Community: open Communities, open the one you want, click Join.
${TOOLS_NOTE}
`;

const YOUTUBE_SKILL = `---
name: youtube
description: Watch/read, comment, reply, like, and subscribe (join channels) on YouTube as the logged-in user, through a real browser. Use whenever the user asks to do something on YouTube.
---

# YouTube (connected browser)

Home: https://www.youtube.com  ·  a video: https://www.youtube.com/watch?v=<id>  ·  a channel:
https://www.youtube.com/@<handle>  ·  your subscriptions: https://www.youtube.com/feed/subscriptions

- Read comments / video info: open the video, \`browser_snapshot\` (scroll to load comments with \`browser_wait_for\`).
- Comment: open the video, click "Add a comment", \`browser_type\`, then Comment.
- Reply: expand the target comment, click Reply, type, submit.
- Like a video: click the like control under the player.
- Subscribe (join a channel): open the channel or video and click Subscribe; for paid memberships click Join.
- Note: creating **Community posts** isn't reliably reachable — do it only if the channel exposes the composer.
${TOOLS_NOTE}
`;

export const browserProviders: Record<BrowserPlatform, BrowserProvider> = {
    reddit: { loginUrl: "https://www.reddit.com/login/", skill: REDDIT_SKILL },
    // The dedicated login flow (not the app shell) so the screencast opens straight on the sign-in form.
    x: { loginUrl: "https://x.com/i/flow/login", skill: X_SKILL },
    // Google sign-in, returning to YouTube once done. Google is the strictest about automated logins — the human
    // completing it in the screencast is what gets past that.
    youtube: { loginUrl: "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Fwww.youtube.com%2F", skill: YOUTUBE_SKILL },
};
