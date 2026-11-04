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

  // ../../_shared/sandbox-contract/dist/app-routes/app-pages.js
  var SANDBOX_PAGES = {
    chat: `chat`,
    agents: `agents`,
    agent: `agents/:id`,
    agentPage: `agents/:id/pages/:page`,
    workspace: `workspace/:path(.*)*`,
    browsers: `browsers/:tab(.*)?`,
    devices: `devices`,
    capabilities: `capabilities/:entry?`,
    extension: `ext/:ext/:key?`,
    sandboxSettings: `settings/:tab?`,
    terminal: `terminal`,
    menu: `menu`
  };
  var ACCOUNT_PAGES = {
    account: `account/:tab?`,
    deletedSandboxes: `deleted-sandboxes`
  };
  var PAGE_PATTERNS = { ...SANDBOX_PAGES, ...ACCOUNT_PAGES };
  var TOP_PAGES = {
    root: ``,
    login: `login`,
    loginConfirm: `login/confirm`,
    setup: `setup`,
    startHosted: `start/hosted`,
    invite: `invite/:token`,
    recover: `recover`,
    open: `open`,
    previewPass: `preview-pass`,
    platformUnavailable: `platform-unavailable`,
    desktopAuth: `desktop-auth`,
    desktopAuthComplete: `desktop-auth/complete`,
    kit: `kit`,
    kitRepair: `kit/repair`
  };

  // ../../_shared/sandbox-contract/dist/app-routes/patterns.js
  var PARAM = /^:([A-Za-z_][A-Za-z0-9_]*)(?:\(([^)]*)\))?([?*+])?$/;
  var parse = (pattern) => pattern.split(`/`).filter((segment) => segment !== ``).map((segment) => {
    const param = PARAM.exec(segment);
    if (param === null) {
      return { kind: `static`, text: segment };
    }
    const [, name = ``, regex, modifier] = param;
    const repeat = modifier === `*` || modifier === `+`;
    const part = { kind: `param`, name, spans: repeat || regex === `.*`, optional: modifier === `?` || modifier === `*` };
    return regex === void 0 || regex === `.*` ? part : { ...part, choices: regex };
  });
  var cache = /* @__PURE__ */ new Map();
  var partsOf = (pattern) => {
    let parts = cache.get(pattern);
    if (parts === void 0) {
      parts = parse(pattern);
      cache.set(pattern, parts);
    }
    return parts;
  };
  var encodeSegment = (text) => encodeURIComponent(text).replace(/%3A/gi, `:`).replace(/%40/g, `@`).replace(/%2C/gi, `,`);
  var segmentsOf = (value) => value.split(`/`).filter((segment) => segment !== ``);
  var fillPattern = (pattern, params = {}) => {
    const out = [];
    for (const part of partsOf(pattern)) {
      if (part.kind === `static`) {
        out.push(part.text);
        continue;
      }
      const value = params[part.name];
      const segments = value === void 0 ? [] : part.spans ? segmentsOf(value) : [value];
      if (segments.length === 0 || segments[0] === ``) {
        if (!part.optional) {
          throw new Error(`The address ${pattern} needs its :${part.name}.`);
        }
        continue;
      }
      out.push(segments.map(encodeSegment).join(`/`));
    }
    return out.join(`/`);
  };

  // ../../_shared/sandbox-contract/dist/app-routes/paths.js
  var queryString = (query) => {
    const entries = Object.entries(query).filter((entry) => entry[1] !== void 0 && entry[1] !== ``);
    return entries.length === 0 ? `` : `?${new URLSearchParams(entries).toString()}`;
  };
  var joined = (...parts) => `/${parts.filter((part) => part !== ``).join(`/`)}`;
  var topPath = (name, params = {}, query = {}) => `${joined(fillPattern(TOP_PAGES[name], params))}${queryString(query)}`;
  var PAGE_NAMES = Object.keys(PAGE_PATTERNS);

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
    afterSignOut: topPath(`login`)
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
