"use strict";
(() => {
  // src/environments/environment.default.ts
  var defaultEnv = {
    production: false,
    // Browser-facing origin of the API the SPA calls directly (no dev-server proxy).
    api: { url: `` },
    // Public Google web client id for browser-side sign-in (the sandbox-facing ID token); empty by default.
    auth: { googleClientId: `` },
    // Analytics off by default (empty key). PostHog Cloud US, addressed directly — only dev lands on this
    // default, and there is no nginx there to run the /wire proxy the deployment env points at.
    analytics: { posthogKey: ``, posthogHost: `https://us.i.posthog.com` }
  };

  // src/environments/environment.local.ts
  window.env = {
    ...defaultEnv,
    api: { url: "https://localhost:6480" },
    // Public web client id (authorize the dev origin, https://localhost:47145, as a JS origin on this client).
    // Reach the SPA at exactly that host — https://127.0.0.1:47145 is a different origin to both Google and the
    // API's CORS check, and the API answers its preflight 204 with no allow-origin header (sign-in then fails).
    auth: { googleClientId: `481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com` }
  };
})();
