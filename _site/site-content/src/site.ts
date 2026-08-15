export const SITE_URL = "https://intentic.dev";
export const APP_URL = "https://app.intentic.dev";
// The platform API. The site is static, so the one page that shows live numbers — the pool ledger — reads
// them from here in the browser. That endpoint is public and unauthenticated by design; a number anybody is
// asked to trust should not need a login to check.
export const API_URL = "https://api.intentic.dev";
// The interactive demo (@intentic-dev/demo): the real app running against a recorded fixture instead of a
// sandbox. It builds into this site's own public/, so it ships in one deploy. More importantly, the
// hero's iframe is SAME-ORIGIN: a cross-origin frame gets partitioned storage, and the demo seeds credentials
// into localStorage before the app boots. Relative, so a preview deploy embeds its own copy rather than prod's.
export const DEMO_PATH = "/demo/";
export const ORG_NAME = "intentic";
/* The brand line: the working stance in three beats. It names the ACTOR, in the app's own word for it —
 * "agent" is what the /agents board, the API and the docs call it without exception — because the pronoun
 * this replaced had no antecedent above the fold and left the stance without a subject. It still licenses
 * no second word for the machine: that is the **sandbox**, without exception, and prose that needs the host
 * machine says "laptop, desktop or VPS". See docs/marketing/messaging.md for the rule. */
export const ORG_TAGLINE = "You delegate. Agents work. You approve.";
export const ORG_DESCRIPTION =
    "A workspace for coding agents. You delegate. Agents work. You approve. Each one works in a sandbox on hardware you own, in its own git worktree. It keeps running when you close the browser. Reopen from any device, steer the same fleet, and read every diff before it lands. Free.";
export const LOGO_URL = `${SITE_URL}/assets/intentic-logo-sized.png`;
export const FOUNDER_NAME = "Artur Kurowski";

export const orgUrl = "https://github.com/intentic";
export const githubUrl = "https://github.com/intentic/intentic";
export const githubIssuesUrl = "https://github.com/intentic/intentic/issues";
export const githubReleasesUrl = "https://github.com/intentic/intentic/releases";

/* The community server. It is the fast, human channel, and the site is deliberate about which of the two it
 * offers where: a QUESTION goes here, a BUG goes to Issues. An invite link is the only address Discord has,
 * there is no stable /channels/ URL a stranger can open. So this is a permanent, non-expiring invite. */
export const discordUrl = "https://discord.gg/3veuzYp32T";

/* The founder's public profiles. They are here rather than in about.ts because two consumers need them
 * and neither owns them: the visible link chips on /about/ and the landing band, and `sameAs` in the
 * Organization and Person schemas, which is how a search engine or an answer engine resolves "who is
 * behind this domain" to a person it already knows about. */
export const githubProfileUrl = "https://github.com/radarsu";
export const linkedinProfileUrl = "https://www.linkedin.com/in/radarsu/";
export const personalSiteUrl = "https://radarsu.com/";

/* The org's official profiles, which is how a search or answer engine resolves this domain to an entity it
 * already knows. The Discord invite belongs here for the same reason the GitHub org does: it is a place this
 * project is, publicly, under its own name. */
export const SAME_AS: readonly string[] = [orgUrl, githubUrl, discordUrl];
export const FOUNDER_SAME_AS: readonly string[] = [githubProfileUrl, linkedinProfileUrl, personalSiteUrl];
