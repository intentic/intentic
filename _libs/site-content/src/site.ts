export const SITE_URL = "https://intentic.dev";
export const APP_URL = "https://app.intentic.dev";
// The interactive demo: the real app (_apps/web, built through vite.demo.config.ts) running against a recorded
// fixture instead of a sandbox. Its own origin, so the hero can embed it without the app bundle ever reaching
// this page's critical path — and so a demo deploy is never an app deploy.
export const DEMO_URL = "https://demo.intentic.dev";
export const ORG_NAME = "intentic";
export const ORG_TAGLINE = "An IDE for your agents. A window for you.";
export const ORG_DESCRIPTION =
    "An IDE for your agents. A window for you. intentic gives each coding agent — Claude Code, Codex, or Grok — its own sandbox on hardware you own: the dev-tools its job needs really installed, wired to your systems, its context curated for one job — and every layer of that environment visible and yours to change. Run one, or ten in parallel. Free to start.";
export const LOGO_URL = `${SITE_URL}/assets/intentic-logo-sized.png`;
export const FOUNDER_NAME = "Artur Kurowski";
export const FOUNDER_URL = "https://gitlab.com/radarsu";

export const gitlabUrl = "https://gitlab.com/radarsu/intentic";
export const gitlabProfileUrl = "https://gitlab.com/radarsu";
export const gitlabIssuesUrl = "https://gitlab.com/radarsu/intentic/-/issues";

export const SAME_AS: readonly string[] = [gitlabUrl, gitlabProfileUrl];
