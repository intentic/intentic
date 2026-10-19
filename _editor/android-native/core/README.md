# intentic-mobile-core

The Rust half of the native Android spike: the transcript, its markdown and code highlighting turned into styled text, and the streamed turn, called from Kotlin through JNI.

- **Why Rust here.** This is the work that costs a phone its frames in the web editor: parsing markdown and
  highlighting code for every row, and re-rendering a row as a streamed turn grows it. In Rust it allocates nothing
  the garbage collector has to find, and Kotlin only lays out text that is already styled.
- **One string and a span list per row.** `render` returns the row's text and its styles as flat
  `[start, end, kind, arg]` quads in UTF-16 offsets, the units a Kotlin `String` counts in, so a row crosses JNI as
  one `String` and one `int[]` instead of an object per run. The kinds are the `SPAN_*` constants in `src/render.rs`,
  mirrored in the app's `Spans.kt`.
- **Same text as the web labs.** `transcript.rs` inflates `../fixture/soft-deletes.json` the way `_tools/perf`
  inflates the demo's conversation, and `stream.rs` streams the turn `_tools/perf/src/chat/stream.ts` streams.
- **Arm C draws the transcript itself, behind the `surface` feature.** `src/surface/` lays rows out lazily up from the
  bottom with cosmic-text, from the same `render` output, and draws them with wgpu (Vulkan, else GL ES) and glyphon
  onto the app's `SurfaceView`, for `dev.intentic.spike.SurfaceCore`. The app builds the core with it; `cargo test`
  without it never compiles the GPU crates.
- **Highlighting runs on Oniguruma, built from C.** A grammar compiles its regexes the first time a block in its
  language is highlighted. With syntect's pure-Rust engine (`default-fancy`) that took about 32ms for the JavaScript
  grammar on the sandbox and held a Galaxy S10's cold start for about 110ms, until the first screen's rows were built.
  With Oniguruma (`default-onig`) it takes 2ms, and a highlighted block costs 0.2ms instead of 0.6ms. The price is a C
  library in the NDK build, which `cc` compiles through cargo-ndk's toolchain.
- **TypeScript is highlighted with the JavaScript grammar.** syntect's bundled grammars have no TypeScript. Shiki's look
  is not the point of the spike; the cost of highlighting is.

## Key files

- [src/transcript.rs](src/transcript.rs) — the fixture and the inflation rule every arm shares.
- [src/render.rs](src/render.rs) — markdown and code to one string plus span quads.
- [src/stream.rs](src/stream.rs) — the streamed turn as a clock-driven state machine.
- [src/jni_api.rs](src/jni_api.rs) — the functions `dev.intentic.spike.Core` calls.
- [src/surface/mod.rs](src/surface/mod.rs) — arm C's renderer: lazy layout, shaping, the GPU frame.

## Commands

```sh
cargo test --manifest-path _editor/android-native/core/Cargo.toml
cargo test --manifest-path _editor/android-native/core/Cargo.toml --features surface
```
