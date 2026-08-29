# @intentic/fileq

Agent-native file reading: any binary workspace file — docx, xlsx, pptx, pdf, images, audio — as clean, token-budgeted markdown, kept fresh as sidecars from the moment a file lands.

`fileq` is to workspace files what `webq` is to the web and `iq` is to code: the tool an agent reaches for
when the answer is inside a format it cannot open as text. `fileq read` prints a capsule (name, format,
token cost), the content up to a budget, and the path carrying the whole thing. But unlike a web page, a
workspace file has a lifecycle the sandbox can see — so every derivable file also gets a **sidecar**, a
markdown shadow at `.intentic/local/cache/derived/<path>.md`, written when the file lands and converged
when it changes. Reading at reasoning time serves a file that was already derived in the background.

The interesting decisions:

- **Two triggers, one pipeline.** The lazy path (`fileq read`, an agent mid-task) and the eager path (the
  daemon's watcher-driven sweep, gated by the `sidecars` setting) are the same `ensureSidecar` call. The
  sidecar is not a second system beside the CLI; it is the CLI's cache, pre-warmed.
- **Freshness is content, not clocks.** A sidecar's front matter carries the source's sha256 and the
  deriver's version stamp; it is fresh exactly when both still match. Mtimes lie across git checkouts,
  hashes do not, and bumping a deriver's version is how a fixed bug reaches every existing shadow.
- **The deterministic tier only.** Everything here runs without a model and without money: office formats
  and pdf text layers become prose, images become dimensions + EXIF, audio becomes duration + tags. What a
  model-backed tier would add (OCR for scans, whisper transcripts, image captions) is *announced as absent*
  in each sidecar's notes rather than silently missing — an empty shadow must never read as an empty file.
- **Honesty over completeness** (webq's rule, inherited whole): row caps, page caps, scan detection and
  conversion warnings all surface as notes in the capsule and the front matter.
- **Neutralization is in the bytes.** A sidecar is read back by a plain `Read`, which the daemon's
  untrusted-content envelope deliberately does not wrap — so a hostile document's forged
  `</untrusted-content>` or `<system-reminder>` is folded and replaced (`@intentic/base/outside-text`, the
  daemon's own neutralizer) at write time, and the front matter names the provenance. This closes the seam
  the envelope cannot reach: outside content that becomes a workspace file.

## Key files

- [src/lib/derive.ts](src/lib/derive.ts) — `ensureSidecar`, the one pipeline both commands and the daemon run: place, recognize, route, converge.
- [src/lib/sidecar.ts](src/lib/sidecar.ts) — the shadow tree: paths, front matter, content-hash freshness, and the single neutralized writer.
- [src/lib/formats.ts](src/lib/formats.ts) — what is derivable and how it is recognized (magic bytes first); the daemon imports this as its cheap pre-filter.
- [src/lib/derivers/deriver.ts](src/lib/derivers/deriver.ts) — the per-format contract, including the version stamp that re-derives stale shadows.
- [src/lib/sweep.ts](src/lib/sweep.ts) — the whole-workspace pass: converge every candidate, prune orphaned shadows.
- [src/cli.integration.test.ts](src/cli.integration.test.ts) — the whole surface driven in-process against a temp workspace.

## How it fits

The sandbox image bakes the CLI onto `PATH` out of the daemon's own dependency tree (the `lsp`/`iq`/`webq`
precedent in `_sandbox/sandbox/Dockerfile`). The daemon side lives in `_sandbox/sandbox/src/derived/`: a
subscriber on the workspace watcher that pre-filters batches through `@intentic/fileq/formats` and spawns
`fileq derive`/`fileq sweep` — serialized, one process at a time, because derivation shares the box with the
agent it serves. The `fileq` skill (settings/skills.ts, on by default) is what tells agents the binary
exists; the `sidecars` setting (Settings → Agent, off by default) is what turns the eager background pass
on. Deriving reuses webq's DOM→markdown writer (`@intentic/webq/markdown`) rather than growing a second one.

Later tiers extend the same shape, not the same commit: OCR (tesseract), transcripts (whisper-cli, already
in the image's feature pack for voice), and captions (a vision model, costing real money) would each be a
deriver whose absence today is already named in the sidecars it will one day fill. An extension-contributed
deriver registry (a `derivers` manifest point) is the natural end state; nothing here precludes it.

## Conventions & gotchas

- Sidecars live under `.intentic/local/cache/` on purpose: portability `derived` (exports re-derive, never
  carry), watcher-ignored (a sidecar write can never re-trigger the derivation that wrote it), janitor-safe.
- Outside a workspace (`WORKSPACE_ROOT` unset) there are no sidecars; `read` still works and saves its full
  output under `FILEQ_HOME` (XDG default) so a budget cut always has a file to point at.
- Exit codes follow the grep convention agents already know: 0 content, 1 nothing derivable, 2 broken
  invocation or broken install — and a broken install announces itself on stdout instead of dying as a bare
  stack, for the same reason iq's and webq's do.
- The integration suites drive the CLI in-process, not as a child process (webq's harness, webq's reasons),
  and build every binary fixture in code (`src/testing.ts`) so what a fixture contains is reviewable.
- No per-file timeout inside the CLI: a pathological parse is bounded by the daemon's timeout on the spawn,
  and by nothing when run by hand. Sweeps on document-heavy trees take minutes and say so as they go.
