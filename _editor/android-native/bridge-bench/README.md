# bridge-bench

A Kotlin app and a Rust library that time the same three Rust calls made four ways on a phone: hand-written JNI, JNA's direct and interface mappings, and UniFFI's calling convention over JNA.

## Key files

- [src/jni.rs](src/jni.rs) — the JNI functions, written with the `jni` crate as `_editor/mobile-core`'s bridge is,
  plus the echo read with the crate's checked `get_string`, as that bridge reads it today.
- [src/c.rs](src/c.rs) — the same operations as plain C functions, which both JNA modes map by name.
- [android/app/src/jna/kotlin/dev/intentic/bridgebench/Uniffi.kt](android/app/src/jna/kotlin/dev/intentic/bridgebench/Uniffi.kt)
  — UniFFI 0.32's generated Kotlin written out by hand for these calls, over [src/rustbuffer.rs](src/rustbuffer.rs):
  a call-status struct per call, strings and bytes in buffers allocated and freed through Rust. Not generated, so the
  bench has no bindgen step.
- [android/app/src/main/kotlin/dev/intentic/bridgebench/Run.kt](android/app/src/main/kotlin/dev/intentic/bridgebench/Run.kt)
  — the cold start each launch logs as `BENCH_FIRST`: process start to the library loaded, the load alone, the first call.
- [android/app/src/main/kotlin/dev/intentic/bridgebench/CallsActivity.kt](android/app/src/main/kotlin/dev/intentic/bridgebench/CallsActivity.kt)
  — the loops: 10,000 calls of warm-up, then 100,000 timed, on the main thread.
- [bench.ts](bench.ts) — the driver: every mode in rotation, cold starts and call runs, medians and spread.

## Commands

The toolchain is the spike's (`../README.md`, Commands).

```sh
cargo test --manifest-path _editor/android-native/bridge-bench/Cargo.toml
bash _editor/android-native/bridge-bench/android/scripts/gradle.sh :app:assembleRelease
adb install -r _editor/android-native/bridge-bench/android/app/build/outputs/apk/release/app-release.apk
node _editor/android-native/bridge-bench/bench.ts --serial <serial>        # 10 cold starts, 5 call runs per mode
bash _editor/android-native/bridge-bench/android/scripts/apk-size.sh       # what JNA adds to the APK
adb shell am start -S -W -n dev.intentic.bridgebench/.FirstActivity --es mode jna-direct   # one start by hand
```

The modes are `jni`, `jna-direct`, `jna-interface` and `uniffi`. Both activities show over the lock screen, so a locked
phone runs them in the foreground without its settings being touched. The results are in `../README.md`, "Bridge: JNI
or JNA".
