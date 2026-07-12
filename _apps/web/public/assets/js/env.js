"use strict";
(() => {
  // src/environments/environment.default.ts
  var defaultEnv = {
    production: false,
    // Browser-facing origin of the API the SPA calls directly (no dev-server proxy).
    api: { url: `` },
    // Public Google web client id for browser-side sign-in (the sandbox-facing ID token); empty by default.
    auth: { googleClientId: `` },
    // Analytics off by default (empty key). The host is static — one PostHog Cloud EU project for the platform.
    analytics: { posthogKey: ``, posthogHost: `https://us.i.posthog.com` }
  };

  // src/environments/environment.local.ts
  window.env = {
    ...defaultEnv,
    api: { url: `https://localhost:6480` },
    // Public web client id (authorize the dev origin, http://localhost:47145, as a JS origin on this client).
    auth: { googleClientId: `481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com` }
  };
})();
