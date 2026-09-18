# Reviewing a changed Word document

`derived-diff.md` is how a changed `.docx` stopped opening as two Download buttons: the text of both versions as
tracked changes (Changes), and both versions drawn whole by docx-preview (Before / After). This note is what a
reviewer still cannot do with those two readings, what the tools built for this job do instead, and the shape of the
next step: a redline over the rendered document, and marks and locked scrolling in the two-up.

## 1. What the two readings give, and where each stops

**Changes** is compact and honest: one text, insertions underlined, deletions struck, unchanged stretches folded, a
count in the bar, and a verdict when the text did not move. It is what an agent read, which is the point. Its
limits are the text's: bold, lists, tables, numbering, pictures and pages are not in it, a table cell edit reads
as a change to a line of pipes, and a formatting-only change (a heading demoted, a paragraph made bold) is a
verdict line with nothing to point at.

The bar above it also carried every warning mammoth emitted, once per side. On a corporate template that is a
dozen `Unrecognised paragraph style` lines, and both sides' lists stacked when the after version had been re-saved
by another application, since that renumbers every style id and defeats the dedupe. Fixed in this pass: the docx
deriver folds style warnings into one line counting style names (`fileq/src/lib/derivers/docx.ts`, `docx v2`),
and both derived views fold their notes to a count that opens on a press, each note tagged with the side that
hit it when only one did (`viewers/ConversionNotes.vue`).

**Before / After** is the real document, and it marks nothing. The screenshot that prompted this note is a
sixty-page procurement specification whose one change is `dostawy` → `dostawyasd` on the cover; in the two-up
the reviewer finds it by reading both covers. Neither pane follows the other's scroll, so past the first page the
two are on different paragraphs, and at half width each page is drawn small. Unified stacks them, which is
worse for comparison.

Nothing today answers "where are the changes" in the rendered document, and nothing answers "what changed" when
the text did not.

## 2. What the tools built for this do

- **Word, Compare (legal blackline).** One merged document: insertions underlined, deletions struck, in the
  document's own formatting; a Revisions pane listing every change; Next / Previous. The reading every lawyer
  and editor already knows. Google Docs' Compare produces the same as suggestions.
- **Draftable, Litera Compare, Workshare.** Both panes with the changes highlighted, scrolling locked by matched
  paragraph, bands drawn between a change and its counterpart, a change list at the side, an overview strip; and
  the redline as the other reading. Draftable opens on the two-up, Litera on the redline.
- **Acrobat, Compare Files.** Two-up plus a summary ("4 replacements, 2 insertions, 1 deletion"), Next / Previous
  that scrolls both panes to the change, a filter by kind (text, formatting, images).
- **Beyond Compare, Kaleidoscope.** Two-up, locked scroll, a changes-only mode, an overview strip.
- **GitHub's rich diff.** For markdown, the rendered document with inline marks: the redline again.

The common shape: the redline of the rendered document is the reader's default; a count with Next / Previous
and an overview strip is how they move; the two-up keeps its place for layout and pictures, but only with
highlights and locked scrolling; a summary line says the kinds of change before any scrolling.

## 3. The fact that makes it cheap: docx-preview's model is open before it draws

docx-preview is `parseAsync` then `renderDocument`, and its README offers the seam: "this API could be used to
modify document before rendering". What the parse returns (`WordDocument.documentPart.body.children`) is a plain
tree: paragraphs and tables; a paragraph's children are runs (`{ type: "run", children: [{ type: "text", text }] }`),
hyperlinks over runs, bookmarks, and the two revision wrappers `{ type: "inserted" | "deleted", children }` with
`deletedText` for struck text. With `renderChanges: true` the renderer draws those wrappers as `<ins>` and
`<del>` (`renderInserted`, `renderDeleted`), and a `className` set on a paragraph or run becomes a class on its
`<p>` or `<span>` (`renderClass`).

So a Word diff can be computed on that model and drawn by the viewer that already draws the two panes, under the
document's own fonts, styles, numbering, tables and pictures. There is no HTML to diff, no OOXML to rewrite, and
no second renderer.

Three roads not taken, and why:

- **Diffing docx-preview's HTML** (htmldiff and kin). Its classes carry style ids, and a re-save renumbers those,
  so every span reads as changed; and a word-level HTML diff has to be taught which tags are formatting.
- **Rewriting `document.xml` into a tracked-changes docx.** The same run splitting with a worse API (`w:rPr`
  cloning, `w:delText`, revision ids). Worth doing later as an action, "download as a redline .docx", which
  opens in Word with real tracked changes; not as the reading.
- **ONLYOFFICE Compare.** Real, formatting included, and still behind the container, a click path inside its
  own UI, and a listener serving the before version. As `derived-diff.md` left it: a toolbar action, later.

## 4. The proposal: three readings for a docx

The toolbar's control becomes **Changes · Text · Before / After** for a Word document; other formats keep their
two, since their Changes is the text one.

1. **Changes** (default): the redline. The after document drawn whole, with the words removed struck through in
   place and the words added underlined, each tinted; a changed table cell the same; a removed paragraph struck
   where it stood, an added one underlined whole. Nothing is folded, since the pages are the document's; the
   change bar (§7) is how the reader moves.
2. **Text**: today's Changes reading, unchanged. The agent's reading, folded, with the verdict line, and the one
   reading every derivable format has.
3. **Before / After**: the two-up, now marked (§6): changed paragraphs tinted in both panes, removed words struck
   in the before, added words underlined in the after, scrolling locked by matched paragraph, and the same change
   bar moving both panes.

When either side fails to parse, Changes falls back to Text with one line saying which side and why, the way
`DerivedDiffView` already says a side could not be rendered.

## 5. Computing the redline

Everything below is pure functions over the parsed model, testable with fixtures built in code the way
`fileq/src/testing.ts` builds a docx.

**Blocks.** Walk `body.children` in order: a paragraph is a block; a table contributes its cells' paragraphs as
blocks, each with a locator (table, row, cell, paragraph indexes). A block's text is its runs' text concatenated,
tabs and line breaks as `\t` and `\n`, field runs skipped as the renderer skips them. Revision wrappers already
in a document (a docx saved with tracked changes) are resolved to their accepted reading first, on both sides:
inserted children kept, deleted ones dropped.

**Alignment.** The edit script over block texts is `diffSequence` from `proseDiff.ts`, then `pairRun`'s rule: a
run of removals followed by additions between two kept blocks is the same paragraphs edited, paired in order and
word-diffed with `wordDiff`, the rest removed or added whole. That code moves out of `_editor/web` into a shared
module (`@intentic/ui/diff`), since the viewers extension cannot import the app.

**Annotation** builds the merged body from the after document:

- *same*: the after block, untouched.
- *added*: the after block, its runs wrapped in one `{ type: "inserted" }`.
- *removed*: the before block inserted ahead of the next kept block, its runs wrapped in `{ type: "deleted" }`,
  each text child retyped `deletedText`.
- *changed*: the segments of `wordDiff` mapped back onto runs by character offset; a run is split at a segment
  edge into two runs sharing its `cssStyle` and `styleName`. Kept and added segments come from the after runs,
  added ones wrapped in `inserted`; removed segments come from the before runs, with the before formatting,
  wrapped in `deleted` at the position the segment left.

Table structure: a row removed or added whole is the before or after row with every cell's runs wrapped; a
table present on one side only is that table, wrapped cell by cell. Rows are aligned by their cells' text with
the same edit script, so a row inserted mid-table does not read as every row below it changed.

**Rendering.** `renderDocument(merged, host, null, { renderChanges: true })` under the after document's package,
so styles, numbering, fonts and pictures are the after's. Two consequences to state in the view, not hide: a
removed paragraph whose style id the after document no longer defines draws in the default style, struck; a
removed picture is drawn as a struck placeholder frame, not fetched from the before package. `ins` and `del`
get the marks `ProseDiffView` uses (success underline, danger strike, each tinted), scoped under
`.docx-wrapper`.

**Cost.** Parsing a 250 KB document is tens of milliseconds; rendering is the work the two-up already does twice,
done once. A document past a few thousand blocks takes the `MAX_CELLS` road `proseDiff` already takes: removed
whole then added whole, said in the bar.

**Where.** The viewers extension, beside `DocxViewer.vue`: `docxRedline.ts` (blocks, alignment, annotation) and
`DocxCompareViewer.vue` (fetch nothing, receive two blobs, parse, annotate, render, expose the change list).
The manifest's viewer entry grows `compare: true`; `viewerRegistry.ts` gets `compareViewerForExtension` beside
`renderViewerForExtension`; `BinaryDiffView` hands both blobs to it; `FileDiffPane`'s fork puts the redline
first for a docx whose compare viewer is registered, the derived text otherwise.

## 6. The two-up, marked and locked

The same alignment, drawn per side rather than merged: each side's own model is annotated and rendered under its
own package, so nothing crosses packages. A `className` on every block carries its index (`docx-block-17`) and
its verdict (`docx-removed`, `docx-changed`, `docx-added`), and the changed runs of each side are wrapped in that
side's own `deleted` or `inserted`. The `<p>` tints and the inline marks are the same CSS as the redline.

Scrolling locks by pairs: on scroll in one pane, the topmost visible block is looked up by its class, its
counterpart (same block for kept ones, the paired block for changed, the nearest kept neighbour for one-sided)
is scrolled to the same offset in the other pane. Zooming stays per pane; the Split / Unified control keeps its
meaning.

## 7. The change bar

One bar over the redline and the two-up, replacing the verdict line the two-up has no use for:

- **the count**, in paragraphs, the same number the Text reading states, so the two readings agree;
- **the kinds**: `2 changed · 1 added · 1 removed`, and once §8 lands, `· 3 formatting`;
- **Previous / Next**, scrolling the pane (both panes in the two-up) to the change and flashing it;
- **an overview strip** on the right edge, a tick per change at its vertical position, like a code editor's
  ruler, since a sixty-page document with one change is the common case;
- **the legend**, underline for added and strike for removed, in the bar's tail once, since a reviewer new to
  redlines meets one here first;
- **provenance**, from `docProps/app.xml`: `re-saved by LibreOffice 24.2 (was Microsoft Word 16)`. It is why a
  −13 KB delta and a wall of renumbered styles arrived with a one-word change, and it is one XML part away in the
  parse the viewer already runs.

## 8. What the text cannot see: formatting-only changes

A block whose text matches on both sides but whose runs differ in `cssStyle` or `styleName`, or whose paragraph
`styleName` differs, is a *formatted* block: tinted amber in the redline and both panes, counted in the bar,
with a tooltip naming the properties that moved (`bold`, `Heading 2 → Body Text`). It is the change the Text
reading can only assert with its verdict line, and the one that makes "the text is the same" a finding rather
than a shrug. A move (the same paragraph removed here and added there) reads as removed and added, as Word
reads it without move tracking; good enough.

## 9. Order of work, and where it stands

1. Done: the conversion notes folded, on the deriver and in both views.
2. Done: the redline (§5) with its change bar (§7: count by kind, Previous / Next, the overview strip, the legend).
   The edit scripts moved to `@intentic/ui/diff` (`_editor/ui/src/lib/textDiff.ts`), reached by extensions as
   `@intentic/extension-ui/diff`; `pairEdits` took an `alike` veto, so a paragraph replaced by an unrelated one
   reads as removed then added rather than a soup of marks, by the share of words the two keep (`similarity`),
   which the prose diff now uses too. The viewers extension carries `docxRedline.ts` (the pure model diff),
   `docxCompare.ts` (parse, redline, render), `DocxCompareViewer.vue` (the bar, the strip, the marks' CSS) and
   `docxFit.ts` (pages zoomed to the pane, which the Before / After viewer gained as well, since an A4 page in a
   half-width pane was clipped past reach of any scroll). A viewer declares `compare: true` in its manifest entry
   and registers a `compare` component; the host's `compareViewerForExtension` finds it and `FileDiffPane` puts
   it first for a two-sided diff. The toolbar reads **Changes · Text · Before / After** for such a format.
   The demo workspace carries a changed Word document (`_site/demo/src/fixture/document.ts`) so the reading can
   be looked at without a sandbox.
3. The two-up marked and locked (§6), on the alignment §5 built.
4. Formatting-only detection and the provenance line (§7, §8).
5. The change bar on the Text reading, so the two readings step the same way.

Left out, as before: ONLYOFFICE Compare; a tracked-changes `.docx` to download; rendered redlines for the other
formats. The last is the same pattern per viewer where a viewer exposes its model (pdf.js's text layer is spans
per text item and would take it), and none of it is needed to make the Word case right.
