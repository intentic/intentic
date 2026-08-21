# @intentic/ext-viewers

Every file format the app can show that is not source code: images, PDFs, video, audio, spreadsheets, documents.

## Responsibilities

- Claim a set of file extensions per viewer, and render those bytes as something to look at.
- Nothing else. A viewer is pure render.

## Key files

- [src/manifest.ts](src/manifest.ts): which extensions each viewer claims, and how it wants its content delivered.
- [src/MediaViewer.vue](src/MediaViewer.vue): audio and video, streamed rather than held.
- [src/SheetViewer.vue](src/SheetViewer.vue): spreadsheet tabs, with parsing and selected-sheet conversion delegated to a worker.
- [src/mediaControls.ts](src/mediaControls.ts): the playback state the media viewers share.
- [src/extension.ts](src/extension.ts): the registration, and the floor this extension sits on.

## How it fits

This is where "what can this app open?" lives. The core resolves a path to TEXT or to opaque bytes and stops
there. Switch this extension off and the workspace still opens every file (as a download) which is the honest
floor, and the reason none of these ever needed a branch in the core.

The host resolves an open file to a viewer, gets the content the way its MANIFEST entry declares, and passes it
in: `text` for the SVG's markup, `blob` for formats that must be parsed whole, `src` (a streaming
`/workspace/media` URL) for audio and video, which are read a window at a time and never held.

Spreadsheet bytes are transferred into a viewer-owned worker. It keeps the parsed workbook alive and returns
sheet names first, then converts a sheet only when selected; the component sanitizes that returned HTML before
putting it in the document. Changing files or closing the viewer terminates the worker.

## Conventions & gotchas

- None of these components touches the daemon, and none of them ever sees a credential.
- Each viewer id must match a manifest declaration: the host refuses a registration the approved manifest never
  named.
- A viewer gets its ONE declared content prop and nothing spare, and that is load-bearing for any viewer whose
  root is itself a component (the image viewer is `<ImageView>`): Vue passes a parent's leftover attrs down to
  such a root and they win over its own bindings, so a stray `src` (even an undefined one) silently replaces
  the URL the viewer just handed its child.
