# intentic-mobile

The native mobile client's Rust core: everything the app does that is not drawing or the platform's own APIs, so the Kotlin above it (and a Swift app later) stays a thin layer of views.

- **A headless client.** The core keeps the sessions, reads the sandbox daemon's streams (`/events`, a conversation's
  `/agent/attach`), applies transcript patches, keeps the local store, and renders rows to text and style spans. The
  app sends requests and draws rows. It never parses the wire itself, so a streamed patch crosses into Kotlin as one
  "rows changed" notice.
- **One bridge, two speeds.** Requests and events cross as JSON through one JNI function and one callback
  (`src/bridge/`). Their Kotlin types are generated from `src/bridge/messages.rs` by typeshare (`scripts/messages.sh`),
  so a message is written once. Rows a list draws every frame cross by functions of their own, as a `String` and an
  `int[]` of `[start, end, kind, arg]` span quads in UTF-16 offsets, the units a Kotlin `String` counts in.
- 2026-10-20: hand-written JNI, not UniFFI. On a Galaxy S10 UniFFI's calling convention cost a 200-byte string call
  131µs against JNI's 1.1µs, mostly its per-call structs rather than JNA itself, which adds only 6 to 7ms to a cold
  start (`../android-native/bridge-bench`). A row read per bind cannot pay that; a JSON request per tap could, but one
  mechanism is less to keep than two.
- **Typed views of the wire, not generated ones.** `src/wire/` declares only the fields the app reads. Its tests check
  those types against the contract's JSON Schema in `_shared/sandbox-contract/contract.lock.json`. The contract's
  objects refuse unknown fields, so a renamed field or a new required one fails a test rather than a phone. Both
  generators tried (typify, quicktype) failed on the contract's unions, or flattened them into structs of optional
  fields.
- **Sign-in and the board, store first.** `src/session/` holds the platform's Better Auth session (the signed cookie
  itself: the platform runs no bearer plugin) and each daemon's own 30-day token, minted from a platform identity
  assertion. `src/client/` sends the kept session, sandboxes and board as the core starts, then refreshes them and
  follows the open sandbox's `/events` stream, reconnecting with backoff. `tests/flow.rs` runs the whole path against a
  fake platform and daemon.
- **A conversation is rows, not frames.** `src/conversation/` keeps an open conversation's rows: the newest page of
  its record, then its live run over `/agent/attach`, whose patches count rows from the run's first one. Each row is
  rendered once per change and read by the list through `Core.rowCount` and `Core.row`, as `Event::Rows` says what
  changed in a list adapter's terms. The board's roster says when an agent starts a new run, which is when an open
  conversation attaches again. A sent message shows at once and is kept in an outbox until the daemon takes it: it
  carries its own id, and the daemon answers a repeated id with what became of the first, so a resend after an outage
  never delivers twice.
- **The store is SQLite,** in the app's data directory (`src/store/`). Migrations are append-only, numbered by SQLite's
  `user_version`.
- **Highlighting runs on Oniguruma.** It compiles a grammar's regexes about 15 times faster than the pure-Rust engine,
  which a Galaxy S10's cold start waited about 110ms for (`../android-native/README.md`, Results).
- **Measured before it was written.** `../android-native` is the spike that chose this stack. Its own core there is
  frozen as the decision record; this crate is the one that grows.

## Key files

- [src/bridge/messages.rs](src/bridge/messages.rs) — every request and event that crosses the bridge.
- [src/bridge/jni.rs](src/bridge/jni.rs) — the JNI functions the app's `Core` binds, and the event thread.
- [src/render/mod.rs](src/render/mod.rs) — markdown and code to one string plus span quads.
- [src/client/mod.rs](src/client/mod.rs) — what the app drives: session, sandboxes, the open sandbox's link.
- [src/conversation/mod.rs](src/conversation/mod.rs) — an open conversation's rows and how a run's patches change them.

## Commands

```sh
cargo test --manifest-path _editor/mobile-core/Cargo.toml
bash _editor/mobile-core/scripts/messages.sh          # rewrite the app's Messages.kt; --check fails when it is stale
node _editor/mobile-core/scripts/api-schemas.mjs      # the platform's schemas the wire tests check against; --check
node _editor/mobile-core/fixtures/record-live.mjs     # record this sandbox's own daemon into fixtures/live/ (ignored)
```

`api-schemas.mjs` reads `@intentic/api-contract`'s built `dist`, so build that package first. Live recordings are
the owner's own conversations: they stay out of git, and `tests/wire/live.rs` decodes them only when present.

The app builds the core for Android with cargo-ndk from Gradle (`../android-app`).
