export const SITE_URL = "https://intentic.dev";
export const APP_URL = "https://app.intentic.dev";
// The interactive demo (@intentic-dev/demo): the real app running against a recorded fixture instead of a
// sandbox. It builds into this site's own public/, so it ships in one deploy and — the part that matters — the
// hero's iframe is SAME-ORIGIN: a cross-origin frame gets partitioned storage, and the demo seeds credentials
// into localStorage before the app boots. Relative, so a preview deploy embeds its own copy rather than prod's.
export const DEMO_PATH = "/demo/";
export const ORG_NAME = "intentic";
/* The brand line, and the one place "workstation" is allowed to appear. It is a metaphor for the claim —
 * a machine of your own, doing real work — and deliberately NOT the name of anything: the thing that
 * exists is the **sandbox**, which is what the app, the API and the docs call it without exception. Prose
 * that needs the noun says "sandbox"; prose that needs the host machine says "laptop, desktop or VPS".
 * See docs/marketing/messaging.md for the rule. */
export const ORG_TAGLINE = "Workstation for your agents. A window for you.";
export const ORG_DESCRIPTION =
    "Workstation for your agents. A window for you. Every agent works in a sandbox on hardware you own, in a git worktree of its own — and keeps running when you close the browser. Reopen from any device, steer the same fleet, and read every diff before it lands. Free.";
export const LOGO_URL = `${SITE_URL}/assets/intentic-logo-sized.png`;
export const FOUNDER_NAME = "Artur Kurowski";

export const orgUrl = "https://github.com/intentic";
export const githubUrl = "https://github.com/intentic/intentic";
export const githubIssuesUrl = "https://github.com/intentic/intentic/issues";
export const githubReleasesUrl = "https://github.com/intentic/intentic/releases";

/* The founder's public profiles. They are here rather than in about.ts because two consumers need them
 * and neither owns them: the visible link chips on /about/ and the landing band, and `sameAs` in the
 * Organization and Person schemas — which is how a search engine or an answer engine resolves "who is
 * behind this domain" to a person it already knows about. */
export const githubProfileUrl = "https://github.com/radarsu";
export const linkedinProfileUrl = "https://www.linkedin.com/in/radarsu/";
export const personalSiteUrl = "https://radarsu.com/";

export const SAME_AS: readonly string[] = [orgUrl, githubUrl];
export const FOUNDER_SAME_AS: readonly string[] = [githubProfileUrl, linkedinProfileUrl, personalSiteUrl];
