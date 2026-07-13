# @intentic/iq-recall

Session recall behind the [`iq`](../../_apps/iq) CLI: indexes Claude Code transcripts (`node:sqlite`) for
topic→file amplification and mid-session forking (`iq sessions`).

**Part of the iq dependency island** — imported only by `@intentic/iq`, and invoked via the `iq` subprocess.
No app or daemon code imports this package, and none should.
