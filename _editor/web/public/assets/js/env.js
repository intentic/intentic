"use strict";
(() => {
  // ../../_tools/constants/dist/index.js
  var GOOGLE_CLIENT_ID = "481795963975-cq9msl6higcd91joidrfp8mjlkuq5fk3.apps.googleusercontent.com";
  var GOOGLE_TOKEN_STORAGE_KEY = `intentic.gid.${GOOGLE_CLIENT_ID}`;

  // src/app/environments/environment.default.ts
  var defaultEnv = {
    production: false,
    // Browser-facing origin of the API the SPA calls directly (no dev-server proxy).
    api: { url: `` },
    // Public Google web client id for browser-side sign-in (the sandbox-facing ID token); empty by default.
    auth: { googleClientId: `` },
    // Analytics off by default (empty key). PostHog Cloud US, addressed directly, only dev lands on this
    // default, and there is no nginx there to run the /wire proxy the deployment env points at.
    analytics: { posthogKey: ``, posthogHost: `https://us.i.posthog.com` },
    // The app's own sign-in page; every real deployment is served at its root. The demo overrides this.
    afterSignOut: `/login`
  };

  // src/app/environments/environment.local.ts
  window.env = {
    ...defaultEnv,
    api: { url: "https://localhost:6480" },
    // Must be reached at https://localhost:47145; 127.0.0.1:47145 is a different origin and sign-in fails there.
    auth: { googleClientId: GOOGLE_CLIENT_ID }
  };
})();
