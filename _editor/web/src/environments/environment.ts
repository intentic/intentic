// Runtime web config (mirrors atlas). environment.local.ts (dev) / environment.deployment.ts (deploy)
// set window.env via an esbuild-bundled script loaded before the app, so the SPA talks to the API
// directly at api.url — no dev-server proxy, calls go cross-origin (the API enables CORS).
export type WebEnvironment = {
    production: boolean;
    api: { url: string };
    // Public Google "Web application" client id. The browser uses it with Google Identity Services to mint an
    // ID token it sends (as a Bearer) directly to its sandbox daemon, which verifies it against Google's JWKS.
    auth: { googleClientId: string };
    // PostHog product analytics (public project key). Empty key = analytics disabled (dev default); the deploy
    // container's envsubst fills $POSTHOG_KEY. See composables/analytics.ts.
    analytics: { posthogKey: string; posthogHost: string };
    // The LOCAL posture: set only by a host application (an editor extension, a CLI preview) that embeds this
    // app over an engine in its local profile — no platform, no sign-in, one loopback daemon. Absent on every
    // hosted deployment. See environments/posture.ts for what setting it changes; `theme` is the host's
    // initial theme document (local/hostTheme.ts), applied at load and replaceable live via message.
    local?: { engineUrl: string; view?: string; label?: string; theme?: unknown };
};

declare global {
    interface Window {
        env: WebEnvironment;
    }
}

const readEnvironment = (): WebEnvironment => {
    if (!window.env) {
        throw new Error(`window.env is not initialized`);
    }
    return window.env;
};

export const environment = readEnvironment();
