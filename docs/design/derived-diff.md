# Diffs of files that are not text

A changed `.docx` used to open in the Changes tab as two boxes reading "Binary file: no preview for this type" and
two Download buttons. This is the design behind what it opens as now: the change to the document's text, drawn as
tracked changes, with both versions drawn whole one press away, and the same for spreadsheets, decks, PDFs,
notebooks and archives.

## 1. What already existed, and what was missing

Three of the four pieces were in the tree before this work:

- **The bytes of both sides.** `/diff/raw` (`_sandbox/sandbox/src/git/changes/diff-raw.ts`) serves either side of
  a file for all four diff sources: uncommitted work, an agent's review (archived agents included), a commit, a
  checkpoint. `BinaryDiffView.vue` fetched them, but drew only pictures.
- **Text from binary files.** `fileq` (`_sandbox/fileq`) renders docx (mammoth), xlsx/ods, pptx/odp, pdf (with OCR
  where tesseract is present), odt, rtf, epub, ipynb and archives to markdown, keeps a content-hash-fresh shadow of
  every workspace file under `.intentic/local/cache/derived/<path>.md`, and is what an agent reads instead of the
  bytes. The file viewer already offered it as the "Text" reading (`DerivedTextView.vue`).
- **Tracked changes over text.** `ProseDiffView.vue` and `proseDiff.ts` draw two texts as one, insertions
  underlined and deletions struck, for markdown and plain text.

The missing piece was the before side. A shadow is keyed by path and holds the current version only; the moment the
file changed, the rendering of what it used to be was gone, and nothing could render a git blob.

## 2. The shape

Two readings for every document, chosen in `DiffToolbar` and remembered as one preference (`ui-diff-document`) for
every such diff at once:

1. **Changes** (default). The daemon renders both versions to text and the browser draws them as tracked changes.
   A spreadsheet's rendering is one table per sheet, so it is drawn as a grid with the cells that moved marked
   instead (`TableDiffView.vue`). A csv or tsv takes the same grid from its own text.
2. **Before / After**. Both versions drawn whole by the format's own viewer, the one the viewers extension
   registers for the extension: docx-preview, the PDF viewer, the slide renderer, the sheet viewer. For a notebook
   or a csv, whose bytes are text, the second reading is the line diff and the control says "Code".

A verdict line does the one thing marks cannot: when both renderings are identical it says the text is the same and
what changed is formatting, pictures or metadata, so a reviewer looking at no marks does not read "nothing changed"
over a file that did.

Pictures keep their own view, and gain the two overlays GitHub offers beside 2-up: **swipe** and **onion skin**
(`ImageCompareView.vue`), for the change two panes cannot show.

## 3. The daemon: `/diff/derived`

`diff-locate.ts` is `/diff/raw`'s resolver pulled out: one `DiffSourceQuery` (a discriminated union over the four
sources, `_shared/sandbox-contract/src/schemas/diff.ts`) to a `BlobLocation` per side, and the side's bytes. Both
routes take the identical query, `which` aside, which is what lets the browser ask for the derived diff from the
side URLs every review surface already hands its viewer (`diffRaw.ts`, `derivedDiffSource`); no payload grew a
field and an extension's own `openDiff` rides along.

`diff-derived.ts` answers both sides in one call, rendered concurrently. Each side goes through
`derived/derived-blob.ts`:

1. hash the bytes;
2. a rendering kept under `.intentic/local/cache/derived-blobs/<sha256>.md` answers at once, whatever the file
   was called, so a staged row, an unstaged row and an agent's review of the same version render once;
3. for the side on disk, the file's own shadow stands in when its front matter carries this hash, which the
   background pass usually has ready before a reviewer opens the diff;
4. otherwise the bytes are written to a temporary copy carrying the file's name (the extension is part of how a
   zip container is recognised) and `fileq read --json --budget 0` renders it. fileq already derives a file outside
   any workspace in memory; the daemon reads back the saved rendering, keeps it under the hash, and removes the
   copy. The child runs inside the same two-slot budget interactive derivations already share (`fileq.ts`,
   `withFileqSlot`).

A side nothing can read answers `{ present: false, reason }` with fileq's own reason; a side that is not there is
absent; a refusal of the whole query (an unknown repo, a path outside its repo) is the call's error. Renderings are
capped at 512 KiB per side, like the shadow route, and say `truncated`.

The daemon's own text-diff path is untouched: `diff-partial.ts` still passes `--no-textconv`.

## 4. Formats, and what each diff is

| Family | Formats | Changes reading | Before / After reading |
|---|---|---|---|
| Word processing | docx, odt/ott, rtf, epub | tracked changes over the rendered text | the format's viewer |
| PDF | pdf | tracked changes over the text layer, OCR for scans | the PDF viewer |
| Slides | pptx, odp/otp/odg | tracked changes; `## Slide N` headings mark slides | the slide renderers |
| Spreadsheets | xlsx, ods/ots | grid per sheet, cells marked, sheets added/removed | the sheet viewer |
| Delimited text | csv, tsv | the same grid, parsed from the text | the line diff |
| Notebooks | ipynb | tracked changes over the cells fileq renders | the JSON line diff |
| Archives | zip, jar, war, whl, tar, tgz, gz, bz2, xz, zst, 7z, rar | tracked changes over the entry list | download |
| Pictures | png, jpg, gif, webp, avif, bmp, ico | 2-up with pixel share, swipe, onion skin | — |
| Everything else a viewer claims | svg, fonts, audio, video | — | that viewer, per side |

Out of scope, with no parser in the tree: psd, sketch, fig, 3D models, geojson maps, sqlite databases. They keep
the download floor.

## 5. Agents' own `git diff`

An agent's `git diff` on a document said "Binary files differ". The sandbox image now names every derivable
extension `diff=fileq` in a global attributes file (`fileq git-attributes > /etc/gitattributes`) and sets
`diff.fileq.textconv` to `fileq read --plain`, so `git diff`, `git show` and `git log -p` print the change to the
text. `--plain` is the body alone, whole, and saves nothing for the temporary file git hands the driver. A repo's own
`.gitattributes` still wins, and no `cachetextconv` is set, since that writes notes into the repository.

## 6. Left out, and why

**ONLYOFFICE compare.** ONLYOFFICE Docs can compare two documents with real Word-style tracked changes, formatting
included, but only behind a click path inside its own UI (Collaboration › Compare › Document from Storage, answered
through `onRequestSelectDocument`/`setRequestedDocument`), only with the document server container running, and
only for the docx family. It would also need the extension's listener to serve the before version to the container.
That is a separate piece of work in an extension that cannot be exercised here without Docker; the derived diff
covers the reading a reviewer needs first. If wanted later, it is an action on the toolbar ("Compare in ONLYOFFICE")
that opens the editor with a compare token, not a change to any of the above.

**Row counts on the Changes list.** The rows' ± numbers are git's, computed at list time; deriving every document
in a list to count paragraphs would cost a render per row. The count lives in the diff's own bar instead.

## 7. Files

- Contract: `_shared/sandbox-contract/src/schemas/diff.ts`, `contracts/diff.contract.ts`.
- Daemon: `git/changes/diff-locate.ts`, `diff-raw.ts`, `diff-derived.ts`; `derived/derived-blob.ts`,
  `derived/fileq.ts` (the shared slot); `router.ts`, `composition.ts`.
- fileq: `read --plain`, `git-attributes`, the `deriver` stamp in `read --json`.
- Web: `viewers/DerivedDiffView.vue`, `viewers/table/` (`TableDiffView.vue` + `tableDiff.ts`, run in `tableDiffWorker.ts`), `ImageCompareView.vue`,
  `BinaryDiffView.vue` (viewer per side, overlays), `FileDiffPane.vue` (the fork), `DiffToolbar.vue` (the reading
  control), `derivedDiff.ts`, `changes/diffRaw.ts` (`derivedDiffSource`), `explorer/fileType.ts`
  (`isDocumentPath`, `isSpreadsheetPath`, `isDelimitedPath`), `core-views/viewerRegistry.ts`
  (`renderViewerForExtension`), `shell/window/useLayout.ts` (`diffDocument`).
- Image: `_sandbox/sandbox/Dockerfile` (attributes file and textconv driver).
