import { defaultEnv } from "./environment.default";

// Dev: the browser calls the API directly at its origin. esbuild bundles this into public/assets/js/env.js
// before `vite` (see package.json). The API_PORT default is 6480. HTTPS in dev (the SPA is served over
// https://localhost:47145 with the @intentic-app/localhost-https cert) so Google's FedCM One Tap works, it
// fails on http://localhost; an https page must also call an https API (mixed content otherwise).
// Filled by esbuild from $API_URL (falls back to https://localhost:6480, see package.json), so a preview
// daemon can point the dev bundle at a non-local API.
declare const __API_URL__: string;

window.env = {
    ...defaultEnv,
    api: { url: __API_URL__ },
    // Public web client id (authorize the dev origin, https://localhost:47145, as a JS origin on this client).
    // Reach the SPA at exactly that host, https://127.0.0.1:47145 is a different origin to both Google and the
    // API's CORS check, and the API answers its preflight 204 with no allow-origin header (sign-in then fails).
    auth: { googleClientId: `481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com` },
};
