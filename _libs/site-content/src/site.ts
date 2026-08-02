export const SITE_URL = "https://intentic.dev";
export const APP_URL = "https://app.intentic.dev";
// The interactive demo (@intentic-dev/demo): the real app running against a recorded fixture instead of a
// sandbox. It builds into this site's own public/, so it ships in one deploy and — the part that matters — the
// hero's iframe is SAME-ORIGIN: a cross-origin frame gets partitioned storage, and the demo seeds credentials
// into localStorage before the app boots. Relative, so a preview deploy embeds its own copy rather than prod's.
export const DEMO_PATH = "/demo/";
export const ORG_NAME = "intentic";
export const ORG_TAGLINE = "An IDE for your agents. A window for you.";
export const ORG_DESCRIPTION =
    "An IDE for your agents. A window for you. intentic gives each coding agent — Claude Code, Codex, Grok, Kimi Code or Gemini — a sandbox of its own on hardware you own, with the job's dev-tools really installed, wired to your systems, and its own git branch. Run one, or ten in parallel: you watch the board, answer the ones that stop, and read every diff before it lands. Free to start.";
export const LOGO_URL = `${SITE_URL}/assets/intentic-logo-sized.png`;
export const FOUNDER_NAME = "Artur Kurowski";
export const FOUNDER_URL = "https://gitlab.com/radarsu";

export const gitlabUrl = "https://gitlab.com/radarsu/intentic";
export const gitlabProfileUrl = "https://gitlab.com/radarsu";
export const gitlabIssuesUrl = "https://gitlab.com/radarsu/intentic/-/issues";

export const SAME_AS: readonly string[] = [gitlabUrl, gitlabProfileUrl];
