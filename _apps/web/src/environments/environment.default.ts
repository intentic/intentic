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
    // The intentic connect scripts the setup/infra/sync screens wrap into copy-paste one-liners. Dev fetches
    // straight from the public repo's main (ease of development); environment.deployment.ts overrides with the
    // intentic.dev vanity URLs, which redirect to the scripts of the latest release (the `stable` git tag).
    scriptUrls: {
        sh: `https://gitlab.com/radarsu/intentic/-/raw/main/scripts/connect.sh`,
        ps1: `https://gitlab.com/radarsu/intentic/-/raw/main/scripts/connect.ps1`,
        hostSh: `https://gitlab.com/radarsu/intentic/-/raw/main/scripts/connect-host.sh`,
        hostPs1: `https://gitlab.com/radarsu/intentic/-/raw/main/scripts/connect-host.ps1`,
        desktopSh: `https://gitlab.com/radarsu/intentic/-/raw/main/scripts/sync.sh`,
        desktopPs1: `https://gitlab.com/radarsu/intentic/-/raw/main/scripts/sync.ps1`,
        rebuild: `https://gitlab.com/radarsu/intentic/-/raw/main/scripts/rebuild.sh`,
        update: `https://gitlab.com/radarsu/intentic/-/raw/main/scripts/update.sh`,
    },
};
