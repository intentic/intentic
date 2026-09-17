# @intentic/fileq

Agent-native file reading: any binary workspace file — docx, odt, rtf, xlsx, ods, pptx, odp, pdf, epub, ipynb, images, audio, archives — as clean, token-budgeted markdown, kept fresh as sidecars from the moment a file lands.

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
- **A container's shadow is its manifest.** An archive is not a document: what a zip, a tar or a wheel *is*
  is the list of what it holds, so those derive to a capped table of members and sizes and stop there,
  saying in a note that the contents are not derived. The exception is a single compressed file
  (`server.log.gz`), where the archive is only a wrapper and the text inside it is the document. Nested
  archives are listed as members, never opened: one level is a fact about this file, two is a crawl.
- **The deterministic tier, plus what the image happens to carry.** Everything here runs without a model
  and without money: office and OpenDocument formats, EPUB chapters, notebook cells and pdf text layers
  become prose, images become dimensions + EXIF, audio becomes duration + tags, archives become listings.
  Zip, tar and gzip are read in process; xz, bzip2 and zstd are codecs the image carries as binaries but
  node_modules cannot decompress, so GNU tar lists those when it is on PATH (the stamp says `archive+tar`)
  and the sidecar says so plainly when it is not. A scanned pdf is OCR'd
  when `tesseract` and `pdftoppm` are on PATH (an extension's image layer puts them there; the core image
  does not), capped at twenty pages and labelled *recognised, not exact*; the pdf deriver's sidecar stamp
  names that capability (`pdf+ocr` vs `pdf`), so a shadow written before the layer arrived re-derives the
  next time it is touched. What a model-backed tier would add (whisper transcripts, image captions) is
  *announced as absent* in each sidecar's notes rather than silently missing — an empty shadow must never
  read as an empty file.
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
- [src/lib/archives.ts](src/lib/archives.ts) — an archive's index without unpacking it: zip's central directory, tar's header blocks, gzip's trailer, and GNU tar for the codecs node_modules cannot decompress.
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
on, and that row reports what the pass is doing — how many shadows the last sweep counted, how many files
are waiting — since this is work with no request of its own to hang a progress indicator on.
Deriving reuses webq's DOM→markdown writer (`@intentic/webq/markdown`) rather than growing a second one.

People read these shadows too, which is the second consumer and the reason `./sidecar` is an export rather
than a private module: the daemon's `src/derived/derived-text.ts` reads one back for the browser (`GET
/workspace/derived`, and `POST /workspace/derive` for the file someone is looking at right now), comparing
the source's hash against the front matter so a shadow of an older version is shown flagged instead of
passing for current. In the workspace view a document, picture or recording gets a **Text** chip beside its
own preview, and a format with no preview at all — an archive, an EPUB — opens on its derived text directly,
since the alternative there is a download button and nothing else.

That reader needs two things the files themselves cannot tell them, and both come from the running service
rather than from disk. **A shadow landing is its own event.** Sidecars are written under the state directory
the watcher ignores on purpose, so no workspace-change frame can ever carry one — the service announces the
paths it just wrote (`subscribeDerived`, pushed as `derivedChanged`) and the open pane re-reads on that
alone. Without it a reader watching a file waits for text that already arrived. **And a wait is reported as
a wait**: every answer carries `state` (`off`, `queued`, `deriving`, `idle`, `broken`, `undeliverable`) and
the pass's own `queue`, also served bare at `GET /workspace/derived-status` for the setting's row, so an
unrendered file and a file thirty deep in the queue stop looking identical. The empty state points at
Settings → Agent only where `state` is `off`; pointing at a switch that is already on is what it used to do.

`state` is also what decides who reads a file nobody has read yet. Opening one asks for it (`POST
/workspace/derive`) without waiting to be told to, because opening the text IS the request and one ordinary
document is a few hundred milliseconds — except where the answer says someone else has it: `deriving`, or
`queued` behind a named batch, which is seconds away. A `queued` behind a whole-tree **sweep** is not left
alone, since that converges hundreds of files and the reader would wait behind all of them. One version of a
file is asked for once per tab, so a file that renders to nothing is not re-read on every frame that lands.
The daemon shares one run between callers asking for the same path and holds itself to two at a time, so a
reader walking a folder of documents cannot put a child process per file on the box.

Later tiers extend the same shape, not the same commit: transcripts (whisper-cli, already in the image's
feature pack for voice) and captions (a vision model, costing real money) would each be a deriver whose
absence today is already named in the sidecars it will one day fill, the way OCR was until an image layer
carried tesseract. An extension-contributed deriver registry (a `derivers` manifest point) is the natural
end state; nothing here precludes it. The zip-of-XML derivers (pptx, odt, ods, odp, epub) share `src/lib/xml.ts` —
entity decoding and attribute reading over machine-written markup — rather than a parser, and `src/lib/tools.ts`
is the one place a deriver asks whether a binary is on PATH.

## Git reads documents through it

`fileq git-attributes` prints a gitattributes file naming every derivable extension `diff=fileq`; the sandbox image
installs it as `core.attributesFile` with `diff.fileq.textconv = fileq read --plain`, so an agent's `git diff`,
`git show` and `git log -p` on a .docx, .xlsx or .pdf print the change to its text rather than "Binary files
differ". `--plain` is the body alone, whole, and saves nothing for a file outside the workspace, since git hands the
driver one temp file per blob. The daemon never relies on it: its own patch route passes `--no-textconv`, and the
review surfaces render both versions through `/diff/derived` (the daemon's `derived/derived-blob.ts`).

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
- A deriver's parser is loaded inside its `derive()`, never at the top of its module: `derive.ts` imports all
  eleven so `read` and `derive` cannot disagree about a file, which means one top-level `import` is paid by
  every run — an agent reading a png, a sweep with nothing stale in it, `fileq --version`. exceljs, mammoth
  and music-metadata together were ~1.3s of a ~1.4s no-op run; moving them took `fileq --version` from ~560ms
  to ~120ms, and reading one ordinary document from ~400ms to ~150ms. `src/lib/derivers/load-cost.test.ts`
  holds the line.
