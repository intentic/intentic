# intentic-spike-flutter

Arm B of the native Android spike, the Flutter control: the conversation every arm draws, written the way a typical Flutter team would write it.

- **What it draws.** The web demo's soft-deletes conversation (`../fixture/soft-deletes.json`), inflated to `rows`
  rows by the rule every arm shares, in a reversed `ListView.builder` that opens at the newest row and builds only the
  visible ones. A prompt is a right-aligned bubble, an answer is full-width markdown, a notice is small muted text, and
  each tool call is one line (`▸ Read  api/src/users.ts` done, `◌ Bash` running). A composer at the bottom appends a
  prompt.
- **Packages.** [flutter_markdown_plus](https://pub.dev/packages/flutter_markdown_plus) on
  [markdown](https://pub.dev/packages/markdown) (GitHub-flavored: tables, lists, inline code) parses each row in its
  widget, as the package does by default. Fenced code is highlighted by [re_highlight](https://pub.dev/packages/re_highlight)
  (highlight.js grammars in Dart, `ts` is its TypeScript grammar) through a `pre` element builder.
- **The fixture is a symlink.** Flutter only bundles assets under the package root, so `assets/soft-deletes.json`
  points at `../../fixture/soft-deletes.json`. The built APK carries it as `assets/flutter_assets/assets/soft-deletes.json`.
- **Launch extras.** `rows` (int, 2000), `stream` (boolean, false), `streamDelayMs` (int, 1500), `streamMs` (int,
  10000). `MainActivity.kt` reads them and Dart asks for them over the `dev.intentic.spike/launch` method channel.
- **Readiness.** `main()` reads the extras and the fixture before `runApp`, so Flutter's first frame already holds the
  rows. When the engine reports that frame rasterized (its first `FrameTiming`, which is never batched), Kotlin calls
  `Activity.reportFullyDrawn()` and logs `SPIKE_READY arm=flutter rows=<n> ms=<since process start>` under tag
  `Spike`. With `stream`, the turn starts `streamDelayMs` later, runs on a ticker that catches up on a stopwatch, keeps
  the list pinned to the newest row, and logs `SPIKE_STREAM_DONE arm=flutter rows=<n>` once `streamMs` has passed.

## Key files

- [lib/transcript.dart](lib/transcript.dart) — the inflation rule and the streamed turn, plain Dart so they test without a view.
- [lib/row_view.dart](lib/row_view.dart) — how a row draws: bubble, markdown style sheet, highlighted code, tool lines.
- [lib/conversation.dart](lib/conversation.dart) — the screen: the reversed list, the readiness signal, the stream ticker, the composer.
- [android/app/src/main/kotlin/dev/intentic/spike/flutter/MainActivity.kt](android/app/src/main/kotlin/dev/intentic/spike/flutter/MainActivity.kt) — launch extras in, readiness lines out.
- [test/transcript_test.dart](test/transcript_test.dart) — the inflation and stream rules checked against the fixture.

## Commands

```sh
cd _editor/android-native/flutter
flutter analyze && flutter test
flutter build apk --release --target-platform android-arm64,android-x64
adb install -r build/app/outputs/flutter-apk/app-release.apk
adb shell am start -S -W -n dev.intentic.spike.flutter/.MainActivity --ei rows 2000 --ez stream true
adb logcat -d -s Spike
```

The release APK is signed with the debug key and carries arm64 (a phone) and x86_64 (the emulator) code.
