# @intentic/iq-recall

Session recall behind the [`iq`](../../_search/iq) CLI: what past sessions already worked out.

Indexes Claude Code transcripts (`node:sqlite`) for topic→file amplification and mid-session forking
(`iq sessions`).

**Part of the iq dependency island**: imported only by `@intentic/iq`, and invoked via the `iq` subprocess.
No app or daemon code imports this package, and none should.

## Key files

- [src/ingest](src/ingest): reading Claude Code transcripts into the index.
- [src/rank](src/rank): topic→file amplification; what makes a past session useful now.
- [src/fork](src/fork): resuming a prior session's context instead of rebuilding it.
- [src/store](src/store): the `node:sqlite` index.
- [src/fleet](src/fleet): whose CONVERSATION a runtime session belonged to. A recall row is keyed on the
  provider's bare session uuid and titled from whatever the transcript named itself, which for an agent-run
  session is nothing — so a listing read as a column of uuids and the word "(untitled)" while the daemon next
  door held the branch and title for every one of them. The join is the daemon's fleet registry read as a
  plain file, and it is deliberately tolerant: `iq` runs outside a sandbox too, where the file does not exist
  and the answer is simply that this listing has no conversations to name. A named row's id is the handle the
  sandbox's own `agents show <id>` takes.
- [src/index.ts](src/index.ts): the public surface.
