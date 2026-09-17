# @intentic/ext-onlyoffice

Documents, spreadsheets and presentations opened in ONLYOFFICE Docs, editable and saved back into the workspace,
instead of a read-only rendering.

## Responsibilities

- Claim the office formats (docx/xlsx/pptx families, OpenDocument, RTF, the legacy binary formats) as an EDITING
  viewer, so they outrank the render-only viewers in `viewers` while this extension is on.
- Run the document server: one container (`onlyoffice/documentserver`, pinned in `src/server/document-server.ts`) in
  the sandbox's own Docker engine, pulled on the owner's one explicit start, brought back up on demand after that.
- Hand every open file to that server and write what it saves back, atomically, under the same path.

## Key files

- [intentic-extension.json](intentic-extension.json): the one viewer (`office`, `edit: true`, `fetch: "path"`), the
  `server` bundle, and the three daemon routes the backend may call.
- [src/OnlyOfficeViewer.vue](src/OnlyOfficeViewer.vue): the iframe once the server answers; until then the card for
  each state the backend can be in (Docker off, not started, pulling with a percentage, starting, no outside address,
  a failure with a retry).
- [src/contract.ts](src/contract.ts): the states and the open request, shared by both halves.
- [src/formats.ts](src/formats.ts): which editor (word / cell / slide) each extension opens in; the manifest's list is
  this table flattened and `formats.test.ts` keeps them equal.
- [src/server/server.ts](src/server/server.ts): `activateServer`: the JWT secret, the three routes (`/status`,
  `/start`, `/open`), the listener, reads and atomic writes under the workspace root.
- [src/server/document-server.ts](src/server/document-server.ts): the container's lifecycle as a small state machine
  over the Docker Engine API, and the healthcheck wait.
- [src/server/docker.ts](src/server/docker.ts): the Engine API over its unix socket with node builtins only, and the
  pull stream folded into one percentage.
- [src/server/listener.ts](src/server/listener.ts): the listener outside the daemon's auth: the editor page, the
  document fetch and the save callback (each with its own credential), and the proxy for the server's own UI.
- [src/server/sessions.ts](src/server/sessions.ts): session tokens and the document key rule.
- [src/server/host-page.ts](src/server/host-page.ts): the framed page and the signed editor config.

## How it fits

Two things in the platform decide this shape, and both were verified rather than assumed:

- **The daemon's `/x/<id>/*` namespace is bearer-gated**, and the document server is a separate process that can hold
  no bearer. So the backend opens a listener of its own: the server fetches the document from it and posts saves to
  it, signing both with the JWT secret the two share, and reaches it from inside its container as
  `host.docker.internal` (the engine's host gateway, with `ALLOW_PRIVATE_IP_ADDRESS` set since the server refuses
  private addresses by default).
- **The app's content-security-policy allows no foreign script and any https frame.** The editor's `api.js` cannot
  be loaded into the app document, so the editor lives in an iframe of a page this listener serves, and the listener
  proxies everything else (`/web-apps/…`, the socket.io upgrade) to the container so the page, the script and the
  editor frames share one origin. That origin is the daemon's forwarded-port hostname (`POST /ports/forward`), which
  the preview proxy frames for the editor and pipes WebSockets through; asked for again on every open, since the
  forward table is in-memory and a busy sandbox can evict a slot. The proxy's `frame-ancestors` names the editor
  origins AND `'self'`: the document frame `api.js` creates has this extension's own page as an ancestor, and without
  `'self'` the browser refuses it (`panels/preview-proxy.ts`, and the nested-frame test beside it).

The core learned two small things for this: a viewer can be fed the `path` alone (its backend reads the file), and
a viewer can declare `edit`, which outranks a render-only viewer for the same extension whatever order the two
activated in (`core-views/viewerRegistry.ts`). Switch this extension off and the `viewers` renderers take the
formats back. Nothing here appears on a rail: the file IS the surface.

The document key is what makes saving and co-editing right (`sessions.ts`): the same bytes get the same key, so two
tabs on one file join one session; a file changed on disk by someone else gets a new key, so the next open starts
from the new bytes; and this backend's own save records the stat it left behind, so a re-open after a Ctrl+S keeps
the session. `forcesave` is on, so Ctrl+S writes to the workspace at once; closing the last editor writes too.

## Conventions & gotchas

- The first start is the owner's: opening a document shows a card, not a 2 GB pull. After that the container comes
  back up on demand, and a container built from another image or another secret is recreated to match the pin.
- The JWT secret lives at `.intentic/local/onlyoffice/jwt-secret`: shared across turns, never tracked, kept by the
  volume across rebuilds. The container holds the same value in its environment; that is how a mismatch is noticed.
- Last write wins. An agent that rewrites a file while it is open in the editor will have its change overwritten by
  the editor's next save; the viewer stays mounted through the disk change on purpose (remounting would reload the
  editor mid-session), so the new bytes are read on the next open.
- The backend trusts the viewer's `mode`: the daemon's proxy forwards no principal to a backend, so the viewer asks
  for `view` below maintainer and for a conversation's checkout, and the backend refuses a save for the latter
  outright. A scoped copy is read through `GET /workspace/raw?agent=`; the shared tree straight from disk.
- The forwarded hostname is public by nature, like any forwarded dev server. What it serves without a credential is
  the document server's own UI; a document is reachable only under a session token (the page) or the server's
  signature (the bytes), and a save is accepted only when signed.
- Not here yet: an external ONLYOFFICE Docs address and secret instead of the managed container (a secret setting
  is stripped from reads, so that wants a capability card and `GET /capabilities/{id}/connection`); PDF annotation,
  which the server also does; handing a format back to the read-only viewers while the server is unavailable,
  rather than the card.
