# android-app

The native Android app `dev.intentic.app`: Kotlin views over the Rust core in [../mobile-core](../mobile-core), replacing the Trusted Web Activity that shipped under the same package.

- **Kotlin draws; the core does everything else.** The app sends the core requests and observes its events through
  `Core` (`core/Core.kt`). Both cross as JSON in the shapes `core/Messages.kt` declares. That file is generated from the
  Rust by typeshare and never edited here. Every Gradle build also builds the core with cargo-ndk, for arm64 and
  x86_64, in the release profile.
- **The core's state, kept once.** The core says each part of its state whole (session, sandboxes, board, link),
  once as it boots and again on every change. `state/AppState.kt` listens from before the start and keeps the latest of
  each, so a screen that opens later still has them. The one activity shows sign-in or the board from the session, and
  holds the system's starting window until the first Session event, so neither flashes past the other.
- **Views built in code.** There are no layout files and no Compose: `ui/Ui.kt` is the vocabulary every screen uses.
  The theme is the platform's Material one, since the app draws its own chrome and so needs no AppCompat.
- **Three ways in, as on the web.** Google's sheet through Credential Manager asks for an ID token minted for the web
  client id, which the build reads from `_tools/constants/src/index.ts`. Google answers only if `dev.intentic.app` is
  registered as an Android OAuth client in that client's Google Cloud project, once per signing certificate: the debug
  key, the upload key, and Play's app-signing key. Until the owner registers them, the sheet fails. An emailed
  six-digit code works without that. "Continue in your browser" is the desktop app's PKCE (proof key) handoff: the web's
  `/desktop-auth` signs in in a Custom Tab and comes back on `intentic://auth`. The verifier the app kept is what makes
  that link worth anything.
- **A conversation is drawn the way the spike measured it.** The core renders each row to one string plus style spans
  (`Core.row`). A pool of background threads turns those into styled `StaticLayout`s ahead of the scroll, and a plain
  `View` replays them, so binding a row is an array read. `Event.Rows` tells the list exactly which rows moved. A
  streamed row is rebuilt on the main thread, once per frame however many patches reach it. On the background threads
  it landed frames late on a Galaxy S10's little cores, and a thread of its own cost a third more CPU for the same frames.
  A long press swaps the row for a selectable `TextView` over the same text, for copying.
- **Everything else is the web, in one WebView.** Workspace, the sandbox hub, settings, capabilities, devices, browsers
  and an agent's Changes are the web editor's own screens (`web/`). One WebView is made after the board's first frame
  and moved into each web screen, so only the first of them loads a page. The page runs in `?embed=native` mode
  (`_editor/web`: `app/environments/nativeApp.ts`, and `router/nativeHandoff.ts` for `intenticEmbed`). It hands back
  routes the app draws, and it talks to the app through a message listener that only its own origin can reach. The core lends the WebView its sessions: the platform cookie, and a
  daemon session per sandbox.
- **Preview builds.** Every build but `release` carries `src/preview` (`debug`, `bench`, and the Baseline Profile
  plugin's own builds). It holds the board filled from a fixture, the conversation over the spike's fixture (the core
  opens and streams it itself, `OpenFixture`), a web screen against a local demo of the editor, and the app's own look.
  `bench` is the release build with its own id (`dev.intentic.app.bench`) and the debug key, since a debuggable
  build's frame times say nothing about the one people get. Its conversation preview takes the spike bench's extras
  and logs `SPIKE_READY`, so `../android-native/bench` can time the real app as one more arm.
- **A cold start waits for neither the Keystore nor the core.** Unwrapping the secret took 12–15 ms on a Galaxy S10, and
  49 ms on first launch, when the key is made. The core's library loaded and started in 5 ms. Both run on a thread of
  their own.
- **Colours and strings come from the web, not by hand.** `scripts/theme.mjs` evaluates every semantic role in
  `_editor/ui`'s `semantic-colors.css` (oklch and `color-mix()`, as a browser would) into `values/` and `values-night/`
  `colors.xml`. `scripts/strings.mjs` copies the catalog keys `strings.keys` lists into `strings.xml` in all five
  languages. Both outputs are committed. CI fails when they are stale, and rerunning the script is the fix.
- **Placeholders are numbered in English's order.** `{name}` becomes `%1$s`, `%2$s`… in the order the names first
  appear in the English message, so a call passes the same arguments whichever order a translation uses. A plural's
  quantities come from the web's own plural rules, applied to one sample count per CLDR (Unicode's locale data)
  category, so Polish gets `one`/`few`/`many` exactly where the web picks its three forms.
- **The core's secret never touches disk unwrapped.** The 32 bytes that seal the core's sessions are wrapped by an
  Android Keystore key and kept in `noBackupFilesDir`. A backup restored onto another phone carries the store but not
  the secret, so it opens signed out instead of failing.
- **Signing.** A local release build signs with the debug key. `mobile-release.yml` injects the upload key with
  `-Pandroid.injected.signing.*` and stamps the version code with its run number. That run number is the counter the
  Trusted Web Activity was uploaded with, so every upload stays above it.
- **Passkeys and App Links rest on the web's asset links.** `app.intentic.dev/.well-known/assetlinks.json` is rendered
  by the web container from `ANDROID_APP_FINGERPRINTS`; the repository keeps no template of it. Release note: that
  variable needs the SHA-256 of every certificate that signs a build people install. That means Play's app-signing key,
  plus the upload key for builds sideloaded from CI. The app hands the core its passkey origin,
  `android:apk-key-hash:` and the base64url SHA-256 of its own signing certificate (`auth/PasskeyOrigin.kt`). A sandbox
  that asks for a passkey shows "Use passkey" (or "Add a passkey") over the board. Tapping it runs the ceremony through
  Credential Manager with the options the core fetched (`auth/Passkeys.kt`), and the core reconnects once it went
  through. A link to `https://app.intentic.dev/agents/<id>` opens that conversation natively. A link to one of its
  pages, or to its changes, opens the WebView over it.
- **Every row is one stop for TalkBack.** A conversation row reads its text, a board card its title, activity, status,
  age and steps, and a card's buttons follow its text. Touch targets are at least 48 dp, and lane titles are headings.
  `src/androidTest` runs Accessibility Scanner's checks (espresso-accessibility) over sign-in, the board and a
  conversation. TalkBack itself was not run: turning it on is a system setting.
- **A Baseline Profile ships in every build.** `baselineprofile/` records it on a Gradle-managed Android 14 emulator
  (recording needs Android 13 or root). It covers a cold start, the conversation over the spike's fixture opened,
  scrolled and streaming, and the board. The profile is committed under `app/src/main/baselineProfiles`, and
  `profileinstaller` installs it where the store has not. `benchmark/` times the `bench` build on a phone with
  Macrobenchmark, each test with only the JIT and with the profile. On a Galaxy S10 (Android 12) the two were within
  noise of each other. A cold start to the first frame with rows took 271 ms without the profile and 272 ms with it
  (median of 10). Frame CPU time at P50 was 5.9 and 5.8 ms flinging through rows, and 12.8 and 12.6 ms while rows
  streamed in. The app's own code is a small part of either: the framework is compiled ahead of time already, and the
  core is native.
- **Bundled type.** Public Sans and JetBrains Mono ship as one variable TTF each, under the SIL Open Font License
  (`app/src/main/assets/licenses`). They add about 200 KB to the APK compressed. `store-icon-512.png` is the Play
  listing's icon; the launcher icon is a vector traced from it.

## Key files

- [app/src/main/kotlin/dev/intentic/app/core/Core.kt](app/src/main/kotlin/dev/intentic/app/core/Core.kt) — the JNI
  binding and the typed `send` and `observe` on top of it.
- [app/src/main/kotlin/dev/intentic/app/state/AppState.kt](app/src/main/kotlin/dev/intentic/app/state/AppState.kt) —
  the core's state as the screens read it.
- [app/src/main/kotlin/dev/intentic/app/ui/MainActivity.kt](app/src/main/kotlin/dev/intentic/app/ui/MainActivity.kt) —
  sign-in or the board, and where the browser's sign-in comes back.
- [app/src/main/kotlin/dev/intentic/app/ui/Ui.kt](app/src/main/kotlin/dev/intentic/app/ui/Ui.kt) — the Views-in-code
  builder.
- [app/build.gradle.kts](app/build.gradle.kts) — the app, its release signing, and the cargo-ndk task.
- [scripts/theme.mjs](scripts/theme.mjs) and [scripts/strings.mjs](scripts/strings.mjs) — the colour and string
  generators; [strings.keys](strings.keys) lists the messages the app shows.
- [baselineprofile/](baselineprofile/) and [benchmark/](benchmark/) — the Baseline Profile's recording and the
  Macrobenchmark tests.

## Commands

```sh
bash _editor/android-app/scripts/gradle.sh :app:testDebugUnitTest :app:assembleRelease   # pinned Gradle, no wrapper
node _editor/android-app/scripts/theme.mjs      # colors.xml from the web's CSS; --check fails when stale
node _editor/android-app/scripts/strings.mjs    # strings.xml from the web's catalogs; --check fails when stale
node --test '_editor/android-app/scripts/**/*.test.mjs'
bash _editor/mobile-core/scripts/messages.sh    # core/Messages.kt from the core's messages
adb shell am start -n dev.intentic.app/.PreviewBoard   # debug build: the board filled from a fixture; --es link passkey
bash _editor/android-app/scripts/gradle.sh :app:connectedDebugAndroidTest   # accessibility checks on a phone
bash _editor/android-app/scripts/gradle.sh :app:generateBaselineProfile     # records the profile on an emulator
ANDROID_SERIAL=<phone> bash _editor/android-app/scripts/gradle.sh :benchmark:connectedBenchAndroidTest \
  -Pandroid.injected.androidTest.leaveApksInstalledAfterRun=true             # start, scroll, stream timings
# Before Android 14 Macrobenchmark reinstalls the app per test; where an install stalls, compile it yourself and run
# each benchmark once as it stands (-m verify for no profile; profileinstaller's INSTALL_PROFILE broadcast, then
# -m speed-profile, for the profile):
adb shell am instrument -w -e compilation ignore -e targetAppId dev.intentic.app.bench \
  dev.intentic.app.benchmark/androidx.test.runner.AndroidJUnitRunner
bash _editor/android-app/scripts/gradle.sh :app:assembleBench   # the release build plus the previews
adb shell am start -S -W -n dev.intentic.app.bench/dev.intentic.app.PreviewConversation --ei rows 2000 --ez stream true
adb shell am start -n dev.intentic.app.bench/dev.intentic.app.PreviewLook --es theme dark   # or light, or system
pnpm -C _site/demo dev --port 47148      # the editor's demo for the web screens; in another shell:
adb reverse tcp:47148 tcp:47148
adb shell am start -n dev.intentic.app.bench/dev.intentic.app.PreviewWeb --es web http://127.0.0.1:47148/demo --es path /workspace
```
