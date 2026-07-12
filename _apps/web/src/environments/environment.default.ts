// Base web environment. environment.local.ts (dev) / environment.deployment.ts (deploy) spread this
// and set api.url. esbuild bundles the right one into assets/js/env.js, loaded before the app so
// window.env exists at module-eval time (see environment.ts).
export const defaultEnv = {
    production: false,
    // Browser-facing origin of the API the SPA calls directly (no dev-server proxy).
    api: { url: `` },
    // Public Google web client id for browser-side sign-in (the sandbox-facing ID token); empty by default.
    auth: { googleClientId: `` },
    // Analytics off by default (empty key). The host is static — one PostHog Cloud EU project for the platform.
    analytics: { posthogKey: ``, posthogHost: `https://us.i.posthog.com` },
};
