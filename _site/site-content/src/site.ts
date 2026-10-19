import { COMMUNITY_DISCORD_URL, PLATFORM_SITE_ORIGIN, PLATFORM_WEB_ORIGIN } from "@intentic/constants";

// Re-exported from the shared origin table; the site is a reader, not the owner (APP_URL feeds CORS).
export const SITE_URL = PLATFORM_SITE_ORIGIN;
export const APP_URL = PLATFORM_WEB_ORIGIN;
// The platform API, for the pages that read a live figure from it in the browser.
export const API_URL = "https://api.intentic.dev";
// Relative, same-origin: the demo seeds localStorage before the app boots; cross-origin storage is partitioned.
export const DEMO_PATH = "/demo/";
// The desk product's own page; landing under it is also what turns the site's light edition on (site lib/variant.ts).
export const DESK_PATH = "/desk/";
// The two ways in, worded once: the app is the primary path, the hosted workspace is its labelled alternative.
export const HOSTED_START_LABEL = "Start in your browser";
export const HOSTED_ALT_LABEL = "Or start in your browser";
export const ORG_NAME = "intentic";
// Fixed nouns: "agent" for the actor, "sandbox" for the machine; the host machine is "laptop, desktop or VPS".
export const ORG_TAGLINE = "More work. Less AI waste. Same subscriptions.";
export const ORG_DESCRIPTION =
    "A workspace for coding agents. More work. Less AI waste. Same subscriptions. Each one works in a sandbox, in its own git worktree. It keeps running when you close the browser. Reopen from any device, steer the same fleet and review every change before it is merged. Free.";
export const LOGO_URL = `${SITE_URL}/assets/intentic-logo-sized.png`;
export const FOUNDER_NAME = "Artur Kurowski";

export const orgUrl = "https://github.com/intentic";
export const githubUrl = "https://github.com/intentic/intentic";
export const githubIssuesUrl = "https://github.com/intentic/intentic/issues";
export const githubReleasesUrl = "https://github.com/intentic/intentic/releases";

// Questions go here, bugs to Issues. The editor invites people to the same server (@intentic/constants).
export const discordUrl = COMMUNITY_DISCORD_URL;

// Shared by two consumers (the /about/ + landing chips, and the Person schema's `sameAs`); not in about.ts.
export const githubProfileUrl = "https://github.com/radarsu";
export const linkedinProfileUrl = "https://www.linkedin.com/in/radarsu/";
export const personalSiteUrl = "https://radarsu.com/";

// Official profiles a search engine uses to resolve this domain; Discord belongs here like the GitHub org does.
export const SAME_AS: readonly string[] = [orgUrl, githubUrl, discordUrl];
export const FOUNDER_SAME_AS: readonly string[] = [githubProfileUrl, linkedinProfileUrl, personalSiteUrl];
