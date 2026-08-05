# @intentic/iq-recall

Session recall behind the [`iq`](../../_apps/iq) CLI — what past sessions already worked out.

Indexes Claude Code transcripts (`node:sqlite`) for topic→file amplification and mid-session forking
(`iq sessions`).

**Part of the iq dependency island** — imported only by `@intentic/iq`, and invoked via the `iq` subprocess.
No app or daemon code imports this package, and none should.

## Key files

- [src/ingest](src/ingest) — reading Claude Code transcripts into the index.
- [src/rank](src/rank) — topic→file amplification; what makes a past session useful now.
- [src/fork](src/fork) — resuming a prior session's context instead of rebuilding it.
- [src/store](src/store) — the `node:sqlite` index.
- [src/index.ts](src/index.ts) — the public surface.
