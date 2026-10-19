# intentic-spike-compose

Arm D of the native Android spike: the conversation every arm draws, in plain Kotlin as a typical Compose team would write it. It uses Compose and a Kotlin markdown library, with no Rust and no hand-tuned rendering. This is the "native Kotlin" the other arms have to beat.

- **What it draws.** The web demo's soft-deletes conversation (`../fixture/soft-deletes.json`), inflated to `rows`
  rows by the rule every arm shares. The rows sit in a reversed `LazyColumn` that opens at the newest row and composes
  only the visible ones. A prompt is a right-aligned bubble, an answer is full-width markdown, a notice is small muted
  text, and each tool call takes one line. A Material 3 `TextField` composer at the bottom appends a prompt.
- **Libraries.** mikepenz's [multiplatform-markdown-renderer](https://github.com/mikepenz/multiplatform-markdown-renderer)
  (`-m3`) parses and draws each row's markdown. Its `-code` module highlights fenced code with SnipMe Highlights. Both
  run with their defaults, as the library's README shows them.
- **Kotlin 2.4.21 through AGP 9.** AGP 9.4.1 compiles Kotlin itself, with Kotlin 2.2.10, and that compiler can't read
  the current markdown renderer, which is built with 2.4.21. The Compose and serialization plugins are pinned at
  2.4.21, so that Kotlin Gradle plugin is on the classpath and AGP compiles with it (`build.gradle.kts`).
- **Launch extras.** The same as every arm: `rows` (int, 2000), `stream` (boolean, false), `streamDelayMs` (int,
  1500), `streamMs` (int, 10000), read in `Launch.kt`.
- **Readiness.** The library parses off the main thread, so the first frame with rows still shows them loading.
  `ReportDrawnWhen` waits until every row on screen shows its parsed markdown. activity-compose then calls
  `reportFullyDrawn` on the next frame, and the activity logs `SPIKE_READY arm=compose rows=<n> ms=<since process
  start>` under tag `Spike`. With `stream`, the turn starts `streamDelayMs` later and steps once a frame on
  `withFrameMillis`. It keeps the list pinned to the newest row while the reader is there, and logs
  `SPIKE_STREAM_DONE arm=compose rows=<n>` once `streamMs` has passed.

## Key files

- [app/src/main/kotlin/dev/intentic/spike/compose/Transcript.kt](app/src/main/kotlin/dev/intentic/spike/compose/Transcript.kt): the fixture and the inflation rule.
- [app/src/main/kotlin/dev/intentic/spike/compose/TurnStream.kt](app/src/main/kotlin/dev/intentic/spike/compose/TurnStream.kt): the streamed turn, ported from `core/src/stream.rs`.
- [app/src/main/kotlin/dev/intentic/spike/compose/RowView.kt](app/src/main/kotlin/dev/intentic/spike/compose/RowView.kt): how a row draws, including bubble, markdown, highlighted code and tool lines.
- [app/src/main/kotlin/dev/intentic/spike/compose/ConversationScreen.kt](app/src/main/kotlin/dev/intentic/spike/compose/ConversationScreen.kt): the screen, with the reversed list, the readiness signal, the stream loop and the composer.

## Commands

```sh
bash _editor/android-native/compose/scripts/gradle.sh :app:testDebugUnitTest :app:assembleRelease
adb install -r _editor/android-native/compose/app/build/outputs/apk/release/app-release.apk
adb shell am start -S -W -n dev.intentic.spike.compose/.MainActivity --ei rows 2000 --ez stream true
adb logcat -d -s Spike
```

The release build is minified with R8 and signed with the machine's debug key. A sandbox rebuild makes a new debug
key, and the phone then refuses the update (`INSTALL_FAILED_UPDATE_INCOMPATIBLE`). `adb uninstall
dev.intentic.spike.compose` first, and the same for the other two packages.
