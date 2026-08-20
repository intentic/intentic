# @intentic/ios-app

The App Store shell: the hosted web app in a native iOS frame, with real push notifications.

## What it is — and is not

The same decision the desktop app made, made again for the phone: **one product codebase, thin wrappers.** The
shell is a Capacitor project whose webview loads `https://app.intentic.dev` directly (`capacitor.config.ts`
`server.url`), so every product change ships the moment the web deploy does — no App Store release for UI
work, no second UI codebase, no bundle aging on someone's phone. The web app already speaks every daemon
surface; nothing here duplicates any of it.

What the native frame adds is the one thing a web page cannot have on iOS: **push that arrives when the app is
closed.** WKWebView has no web push, and Apple only accepts pushes from the app's vendor, so the chain runs
through the platform's push relay:

```dag
{ "title": "How a notification reaches the phone", "direction": "LR",
  "nodes": [{ "id": "daemon", "label": "Sandbox daemon", "note": "owner's hardware", "accent": "2" },
            { "id": "relay", "label": "Platform push relay", "note": "_platform/api", "accent": "3" },
            { "id": "apns", "label": "APNs", "note": "Apple", "accent": "neutral" },
            { "id": "shell", "label": "This shell", "note": "closed app included", "accent": "1" }],
  "edges": [{ "from": "daemon", "to": "relay" }, { "from": "relay", "to": "apns" }, { "from": "apns", "to": "shell" }] }
```

The web app detects the shell through the injected bridge (`_editor/web/src/shell/capacitor.ts`) and swaps its
push transport — nothing else about it changes. The Android story is deliberately different and simpler: the
Play app (`_editor/android-app`) is a Trusted Web Activity, real Chrome, ordinary web push, no relay.

## Building and shipping

**Nothing native is committed and no Mac is required to ship.** The native project is generated from the
config on every build (`cap add ios`), CI compiles it, and the release pipeline signs in Apple's cloud —
certificates and profiles are minted on demand by the App Store Connect API key, so no signing material lives
anywhere but Apple's console. The push entitlement rides in as [native/App.entitlements](native/App.entitlements)
(wired into the app target by [scripts/prepare-native.mjs](scripts/prepare-native.mjs) right after
generation — never onto the Pods, which a global build flag would also hit), and the same script fails the
build if a Capacitor upgrade ever ships a template that cannot register for push — the one product-breaking
regression a green compile would hide.

- **Validation** — `.github/workflows/mobile.yml`: on any change here, generates the project and compiles it
  (simulator, unsigned).
- **Release** — `.github/workflows/mobile-release.yml`, a dispatch button: archive, cloud-sign, upload to
  App Store Connect → TestFlight. Submitting to App Review stays a console action on purpose. The secrets it
  needs and the one-time store setup are in that workflow's header comment.

Local development on a Mac is the same flow by hand — **standalone on purpose** (this folder is excluded
from the pnpm workspace; the note in `pnpm-workspace.yaml` says why):

```sh
cd _editor/ios-app
npm install
npm run cap:add:ios      # generates ios/ from the config
npm run cap:open         # open in Xcode to run on a device
INTENTIC_APP_URL=https://localhost:4200 npm run cap:sync   # point a debug build at a local SPA
```

The platform side needs the APNs auth key configured for notifications to flow (`APNS_KEY_P8` etc. —
`_platform/api/src/config.ts`); debug installs need `APNS_URL` pointed at Apple's sandbox gateway.

App Review notes live with the choice they defend: a remote-URL shell passes review on what the NATIVE layer
adds (push, and whatever native affordances land next), so anything that thins that story — removing the push
entitlement, shipping without the offline page — is an App Store risk, not a cleanup.

## Key files

- [capacitor.config.ts](capacitor.config.ts) — the whole shell: app id, the hosted URL the webview loads, the dev override.
- [native/App.entitlements](native/App.entitlements) — the push entitlement prepare-native.mjs wires into the app target.
- [scripts/prepare-native.mjs](scripts/prepare-native.mjs) — finishes a generated project: push-wiring assertion + entitlements.
- [assets/logo.png](assets/logo.png) — the 1024px mark the pipeline turns into icons and splash screens.
- [www/index.html](www/index.html) — the offline fallback, the only page the app itself carries.
