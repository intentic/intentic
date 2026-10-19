"use strict";
(() => {
  // ../../_tools/constants/dist/hosted-tiers.js
  var HOSTED_TIERS = [
    { id: "free", name: "Free", cpuKind: "shared", cpus: 4, memoryMb: 4096, volumeGb: 10, monthlyHours: 40, priceUsd: 0, flyHourUsd: 0.0329 },
    { id: "standard", name: "Standard", cpuKind: "shared", cpus: 8, memoryMb: 8192, volumeGb: 25, monthlyHours: 220, priceUsd: 20, flyHourUsd: 0.0657 },
    { id: "max", name: "Max", cpuKind: "shared", cpus: 8, memoryMb: 16384, volumeGb: 50, monthlyHours: 320, priceUsd: 50, flyHourUsd: 0.1234 }
  ];
  var FREE_TIER = HOSTED_TIERS[0];
  var PAID_TIERS = HOSTED_TIERS.filter((tier) => tier.priceUsd > 0);

  // ../../_tools/constants/dist/one-liner.js
  var SETUP_CODE_PATTERN = /^[A-Za-z0-9]{6,64}$/;
  var SYNC_LEAF_PATTERN = /^[a-z0-9][a-z0-9-]{0,80}$/;
  var FIX_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;
  var SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
  var IMAGE_HASH_PATTERN = /^[a-f0-9]{8,64}$/;
  var SHORT_CODE_PATTERN = /^[0-9A-Za-z]{4}-?[0-9A-Za-z]{4}$/;
  var HOSTNAME_PATTERN = /^(?=.{4,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
  var DEFAULT_SYNC_ROOT = "~/intentic";
  var isOneLinerHost = (host2) => HOSTNAME_PATTERN.test(host2) && !/^\d+$/.test(host2.slice(host2.lastIndexOf(".") + 1));
  var arg = (name, pattern, normalize) => ({
    name,
    test: (value) => pattern.test(value),
    ...normalize === void 0 ? {} : { normalize }
  });
  var slug = arg(`sandbox name`, SLUG_PATTERN);
  var host = { name: `sandbox address`, test: isOneLinerHost, normalize: (value) => value.toLowerCase() };
  var shortCode = arg(`code`, SHORT_CODE_PATTERN);
  var RECREATE = { sh: `recreate.sh`, ps1: `recreate.ps1` };
  var coded = (sh, ps1) => ({
    files: { sh, ps1 },
    required: [host, shortCode],
    optional: [],
    sh: ([address = ``, code = ``]) => ({ args: [address, code] }),
    ps1: ([address = ``, code = ``]) => [
      { name: `Sandbox`, value: address },
      { name: `Code`, value: code }
    ]
  });
  var VERBS = {
    setup: {
      files: { sh: `connect.sh`, ps1: `connect.ps1` },
      required: [arg(`setup code`, SETUP_CODE_PATTERN)],
      optional: [arg(`sync folder`, SYNC_LEAF_PATTERN)],
      sh: ([code = ``, leaf]) => ({ args: [code], env: leaf === void 0 ? [] : [[`SYNC_DIR`, `${DEFAULT_SYNC_ROOT}/${leaf}`]] }),
      ps1: ([code = ``, leaf]) => [
        { name: `SetupCode`, value: code },
        ...leaf === void 0 ? [] : [{ name: `SyncDir`, value: `${DEFAULT_SYNC_ROOT}/${leaf}` }]
      ]
    },
    fix: {
      files: { sh: `fix.sh`, ps1: `fix.ps1` },
      required: [arg(`fix code`, FIX_CODE_PATTERN)],
      optional: [],
      sh: ([code = ``]) => ({ args: [code] }),
      ps1: ([code = ``]) => [{ name: `Code`, value: code }]
    },
    update: {
      files: RECREATE,
      required: [slug],
      optional: [],
      sh: ([name = ``]) => ({ args: [name] }),
      ps1: ([name = ``]) => [{ name: `Slug`, value: name }]
    },
    rollback: {
      files: RECREATE,
      required: [slug],
      optional: [],
      sh: ([name = ``]) => ({ args: [name, `--rollback`] }),
      ps1: ([name = ``]) => [{ name: `Slug`, value: name }, { name: `Rollback` }]
    },
    restart: {
      files: RECREATE,
      required: [slug],
      optional: [],
      sh: ([name = ``]) => ({ args: [name, `--restart`] }),
      ps1: ([name = ``]) => [{ name: `Slug`, value: name }, { name: `Restart` }]
    },
    rebuild: {
      files: RECREATE,
      required: [slug, arg(`image hash`, IMAGE_HASH_PATTERN)],
      optional: [],
      sh: ([name = ``, hash = ``]) => ({ args: [name, hash] }),
      ps1: ([name = ``, hash = ``]) => [
        { name: `Slug`, value: name },
        { name: `Hash`, value: hash }
      ]
    },
    remove: {
      files: { sh: `cleanup.sh`, ps1: `cleanup.ps1` },
      required: [],
      optional: [slug],
      sh: ([name]) => ({ args: name === void 0 ? [] : [name, `--yes`] }),
      ps1: ([name]) => name === void 0 ? [] : [{ name: `Slug`, value: name }, { name: `Yes` }]
    },
    uninstall: {
      files: { sh: `uninstall.sh`, ps1: `uninstall.ps1` },
      required: [],
      optional: [],
      typed: true,
      sh: () => ({ args: [] }),
      ps1: () => []
    },
    device: coded(`device.sh`, `device.ps1`),
    sync: coded(`sync.sh`, `sync.ps1`),
    server: coded(`connect-host.sh`, `connect-host.ps1`)
  };
  var ONE_LINER_VERBS = Object.keys(VERBS);

  // ../../_tools/constants/dist/index.js
  var STATE_DIR = ".intentic";
  var DERIVED_SHADOWS_DIR = `${STATE_DIR}/local/cache/derived`;
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
    analytics: { posthogKey: ``, posthogHost: `https://us.i.posthog.com`, posthogUiHost: `https://us.posthog.com` },
    // The app's own sign-in page; every real deployment is served at its root. The demo overrides this.
    afterSignOut: `/login`
  };

  // src/app/environments/environment.local.ts
  window.env = {
    ...defaultEnv,
    api: { url: "https://localhost:6480" },
    // Must reach the SPA at exactly https://localhost:47145 (authorized as this client's JS origin); 127.0.0.1:47145 is
    // a different origin to both Google and the API's CORS check, and sign-in fails silently there.
    auth: { googleClientId: GOOGLE_CLIENT_ID }
  };
})();
