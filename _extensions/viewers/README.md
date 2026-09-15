# @intentic/ext-viewers

Every file format the app can show that is not source code: images, PDFs, video, audio, spreadsheets, documents,
presentations and books.

## Responsibilities

- Claim a set of file extensions per viewer, and render those bytes as something to look at.
- Nothing else. A viewer is pure render.

## Key files

- [intentic-extension.json](intentic-extension.json): which extensions each viewer claims, and how it wants its
  content delivered; [src/manifest.ts](src/manifest.ts) parses it rather than trusting a literal.
- [src/MediaViewer.vue](src/MediaViewer.vue): audio and video, streamed rather than held.
- [src/SheetViewer.vue](src/SheetViewer.vue): spreadsheet tabs, with parsing and sheet conversion delegated to a
  worker; [src/sheetWorker.ts](src/sheetWorker.ts) decides from the bytes whether it is reading .xlsx or .ods.
- [src/PptxViewer.vue](src/PptxViewer.vue): slides drawn from the boxes [src/pptx](src/pptx) resolved out of the deck.
- [src/pptx/deck.ts](src/pptx/deck.ts): a .pptx to slides — the layout, master and theme walk behind every shape.
- [src/odf/](src/odf/): OpenDocument, from the zip up — the XML parser, the style resolver, the block model every
  document viewer renders, and the DOM renderer that draws it.
- [src/rtf/](src/rtf/): the RTF tokenizer and the reader that turns its control words into the same blocks.
- [src/epub/](src/epub/): an EPUB's structure, and one chapter as a self-contained document for a sandboxed frame.
- [src/DocumentPaper.vue](src/DocumentPaper.vue): the page surface and document typography .odt and .rtf share.
- [src/mediaControls.ts](src/mediaControls.ts): the playback state the media viewers share.
- [src/extension.ts](src/extension.ts): the registration, and the floor this extension sits on.

## How it fits

This is where "what can this app open?" lives. The core resolves a path to TEXT or to opaque bytes and stops
there. Switch this extension off and the workspace still opens every file (as a download) which is the honest
floor, and the reason none of these ever needed a branch in the core.

The host resolves an open file to a viewer, gets the content the way its MANIFEST entry declares, and passes it
in: `text` for the SVG's markup, `blob` for formats that must be parsed whole, `src` (a streaming
`/workspace/media` URL) for audio and video, which are read a window at a time and never held.

Every format here is read in this repository rather than by a library: `src/pptx` resolves each shape against its
layout, its master and the theme, since a slide states almost nothing about itself — a title carries neither its
position nor its size, and its colour is a theme slot with modifiers on it. What comes out is boxes at pixel
positions, which the component only has to draw. Charts, SmartArt and metafile pictures are drawn as labelled
placeholders rather than dropped, and the Text chip beside the viewer is always the fuller reading of a deck this
cannot lay out.

Spreadsheet bytes are transferred into a viewer-owned worker, which keeps the parsed workbook alive and returns
sheet names first, then a sheet's VALUES only when it is selected. Changing files or closing the viewer
terminates the worker.

The OpenDocument and RTF readers are parsed in two steps, and the split is why they can be tested at all: parsing
produces a tree of blocks with CSS already resolved (pure data, no DOM), and [src/odf/render.ts](src/odf/render.ts)
turns that into elements. ODF, RTF and the ODF slide viewer all produce the same blocks, so there is one renderer.

## Conventions & gotchas

- None of these components touches the daemon, and none of them ever sees a credential.
- Each viewer id must match a manifest declaration: the host refuses a registration the approved manifest never
  named, and no two viewers may claim the same extension.
- A viewer gets its ONE declared content prop and nothing spare, and that is load-bearing for any viewer whose
  root is itself a component (the image viewer is `<ImageView>`): Vue passes a parent's leftover attrs down to
  such a root and they win over its own bindings, so a stray `src` (even an undefined one) silently replaces
  the URL the viewer just handed its child.
- A document is untrusted input. No renderer here builds HTML as a string: elements are created and text is set
  as `textContent`, style values are filtered before they reach a declaration, and a document's picture is
  served only from inside its own package. Nothing a file names may be fetched from the network — a remote image
  would tell whoever hosts it that this file was opened.
- EPUB is the exception that proves it: a chapter IS third-party markup, so it renders in an iframe with an empty
  `sandbox` (no scripts, opaque origin) whose content carries a `default-src 'none'` policy, with every resource
  inlined as data.
- `src/odf/xml-tree.ts` exists because the sheet worker has no DOM and neither does a node test. It is also why tags
  are keyed by canonical namespace prefix: a file may bind any prefix it likes to ODF's namespaces.
