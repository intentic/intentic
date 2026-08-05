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
