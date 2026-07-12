import { defaultEnv } from "./environment.default";

// Deploy: $API_URL is substituted (envsubst) when the container starts, so one build artifact serves
// any environment. esbuild bundles this into dist/assets/js/env.js during `vite build` (see package.json).
window.env = {
    ...defaultEnv,
    production: true,
    api: { url: `$API_URL` },
    // The platform's PUBLIC Google web client id is static (one central platform), so it's hardcoded — it must
    // match connect.sh's GOOGLE_CLIENT_ID default (the audience the sandbox verifies). The client must list both
    // the dev origin and app.intentic.dev as authorized JS origins.
    auth: { googleClientId: `481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com` },
    // $POSTHOG_KEY is substituted alongside $API_URL at container start; left literal (analytics stays off)
    // when the deployment doesn't provide one. The EU host comes from defaultEnv.
    analytics: { ...defaultEnv.analytics, posthogKey: `$POSTHOG_KEY` },
};
