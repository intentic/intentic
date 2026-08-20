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

## Working on it

**Standalone on purpose** — this folder is excluded from the pnpm workspace (see the note in
`pnpm-workspace.yaml`): its dependencies feed Xcode and CocoaPods on a Mac, never the monorepo's node
toolchain, so it installs its own `node_modules` on the machine that actually builds it. The native project
(`ios/`) is generated there too:

```sh
cd _editor/ios-app
npm install              # standalone — commit the package-lock.json this mints
npm run cap:add:ios      # once — generates ios/ from the config
npm run cap:sync         # after changing capacitor.config.ts or plugin versions
npm run cap:open         # open in Xcode to run / archive
INTENTIC_APP_URL=https://localhost:4200 npm run cap:sync   # point a debug build at a local SPA
```

After generating, in Xcode: add the **Push Notifications** capability and **Background Modes → Remote
notifications** to the app target, and confirm `AppDelegate.swift` forwards APNs registration to Capacitor
(the two `didRegisterForRemoteNotifications…` methods from the `@capacitor/push-notifications` docs). The
platform side needs the APNs auth key configured (`APNS_KEY_P8` etc. — `_platform/api/src/config.ts`); debug
builds need `APNS_URL` pointed at Apple's sandbox gateway.

App Review notes live with the choice they defend: a remote-URL shell passes review on what the NATIVE layer
adds (push, and whatever native affordances land next), so anything that thins that story — removing the push
entitlement, shipping without the offline page — is an App Store risk, not a cleanup.

## Key files

- [capacitor.config.ts](capacitor.config.ts) — the whole shell: app id, the hosted URL the webview loads, the dev override.
- [www/index.html](www/index.html) — the offline fallback, the only page the app itself carries.
- [package.json](package.json) — Capacitor + the push plugin; the `cap:*` scripts above.
