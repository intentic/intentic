# @intentic/android-app

The Play Store shell: the hosted web app as a Trusted Web Activity — real Chrome, near-zero upkeep.

## What it is — and is not

The Android half of "one product codebase, thin wrappers" (`@intentic/ios-app` is the other half, and this
repository's README of record for the mobile strategy). A Trusted Web Activity is Chrome itself rendering
`app.intentic.dev` full-screen under the app's own icon: the PWA the web app already is — its manifest, its
service worker, its **ordinary web push straight from the daemon** — with a Play Store listing in front. No
webview, no bridge, no relay: the iOS shell needs all three because Apple has no equivalent; Android does, so
this package is deliberately nothing but a build description.

The trust in "Trusted" is the digital asset link: the web origin must serve
`/.well-known/assetlinks.json` naming this app's Play signing certificate, or Chrome shows the URL bar over
the app. That file belongs to the WEB DEPLOYMENT (it lives on the origin, not in this package);
`assetlinks.template.json` here is its content, minus the fingerprint only Play can tell you.

## Shipping it

Everything is generated from `twa-manifest.json` by Bubblewrap (needs a JDK + Android SDK, which it offers to
install itself):

```sh
cd _editor/android-app                                    # standalone — outside the pnpm workspace, like ios-app
npx @bubblewrap/cli init --manifest ./twa-manifest.json   # once — generates the Android project + keystore
npm run twa:build                                         # .aab for the Play Console (+ .apk for a device)
npm run twa:update                                        # re-generate after editing twa-manifest.json
```

Then, once, after the first Play Console upload: copy the **App signing key certificate SHA-256** from the
console into `assetlinks.template.json`'s placeholder, and publish that JSON at
`https://app.intentic.dev/.well-known/assetlinks.json`. Until it is served, the app works but wears a URL bar.

Two gotchas worth their sentence: the version lives in `twa-manifest.json` (`appVersionCode` must bump per
upload), and the generated project + keystore stay out of git — the manifest is the source of truth,
`bubblewrap update` rebuilds the rest, and the UPLOAD keystore matters less than it looks because Play app
signing holds the certificate that the asset link actually names.

## Key files

- [twa-manifest.json](twa-manifest.json) — the whole app: package id, origin, colors, start URL; what Bubblewrap builds from.
- [assetlinks.template.json](assetlinks.template.json) — what the web origin must serve at `/.well-known/assetlinks.json`, fingerprint pending.
- [package.json](package.json) — the two Bubblewrap invocations above.
