import { GOOGLE_CLIENT_ID } from "@intentic/constants";
import { defaultEnv } from "./environment.default";

// Dev only: esbuild fills this from $API_URL (default https://localhost:6480) into public/assets/js/env.js before
// vite runs. Must stay https, since Google FedCM One Tap fails over http and an https page can't call an http API
// (mixed content).
declare const __API_URL__: string;

window.env = {
    ...defaultEnv,
    api: { url: __API_URL__ },
    // Must reach the SPA at exactly https://localhost:47145 (authorized as this client's JS origin); 127.0.0.1:47145 is
    // a different origin to both Google and the API's CORS check, and sign-in fails silently there.
    auth: { googleClientId: GOOGLE_CLIENT_ID },
};
