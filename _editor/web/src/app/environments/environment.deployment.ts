import { GOOGLE_CLIENT_ID } from "@intentic/constants";
import { defaultEnv } from "./environment.default";

// Deploy: $API_URL is substituted (envsubst) when the container starts, so one build artifact serves
// any environment. esbuild bundles this into dist/assets/js/env.js during `vite build` (see package.json).
window.env = {
    ...defaultEnv,
    production: true,
    api: { url: `$API_URL` },
    auth: { googleClientId: GOOGLE_CLIENT_ID },
    // $POSTHOG_KEY is substituted alongside $API_URL at container start; left literal (analytics stays off)
    // when the deployment doesn't provide one. PostHog is addressed through our own origin so that privacy
    // blockers can't strip session replay, nginx.conf proxies /wire to the real hosts, and that prefix is
    // deliberately not one of the names those blockers already pattern-match (see nginx.conf). Read off
    // location.origin rather than $API_URL so the proxy follows whatever domain the SPA is served from.
    analytics: { posthogKey: `$POSTHOG_KEY`, posthogHost: `${window.location.origin}/wire` },
};
