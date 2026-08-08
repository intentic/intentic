# @intentic/ext-memory

What the agent has chosen to remember, as notes you can read and edit.

## Responsibilities

- List the notes the agent has accumulated while working.
- Open one, read it, change it, delete it.
- Serve those notes itself: the extension ships its own backend, and the daemon core carries no memory feature.

## Key files

- [src/contract.ts](src/contract.ts) — the extension's OWN wire contract, imported by both halves so their
  wire cannot drift; paths are relative to the `/x/intentic.memory` namespace the daemon proxies.
- [src/server/server.ts](src/server/server.ts) — the backend half (`activateServer`), built to `dist/server.js`
  (`pnpm build`) and run by the daemon's backend host.
- [src/server/memory-files.ts](src/server/memory-files.ts) — the note tree, scoped hard to
  `.intentic/claude/projects/<project>/memory/**` (the rest of that tree is transcripts and credentials).
- [src/memoryNote.ts](src/memoryNote.ts) — what a note is, and its total parser.
- [src/useMemory.ts](src/useMemory.ts) — reading and writing the note set, via the extension's own namespace
  (no `permissions.sandbox` entry: an extension's own backend needs no grant).
- [src/MemoryView.vue](src/MemoryView.vue) — the section: which note is open, and the drafts held across switches.
- [src/NotePane.vue](src/NotePane.vue) — one note, open.

## How it fits

A **section of the sandbox hub**, beside the agent's own settings — reached from the sandbox chip at the top of
the rail, not from a rail tile of its own. This is the agent's notebook: you come to it when you want to know what
it believes, and it has nothing to announce, so it can never badge. A permanent unlabelled icon that never lights
up spends one of the rail's scarce seats to say nothing, and it spends it against the tiles that do fetch you.
Same rationale as `ext-logs`, which left the rail first.

Memory is native to every sandbox, so the view detects unconditionally — an empty state simply says nothing has
been remembered yet. No repo or capability evidence is needed for something the daemon always has.

## Conventions & gotchas

- The notes are files, not a database. That is what makes them reviewable, greppable, and editable by the agent
  that wrote them without a write API in between.
- **Reading the source and editing it are one surface** — `<CodeField readonly>` and `<CodeField>`. They were two
  (a highlighted block to read, a bare `<textarea>` to write), so a note changed typeface and colour the moment
  you picked up the pen, and the editor was pinned at 256px whatever the note's length. The pane is now sized by
  the file; the panel's own frame is what scrolls.
- **Which note is a picker, not an index column.** As a hub section this view sits beside the hub's own 16rem
  rail, so a rail of its own put two navigation columns in front of the content and left the note — the thing
  being read — the narrowest third of the width. The picker says the same thing on the row the section header
  already occupies. It gives up nothing, because the set is listed inside the view too: `MEMORY.md` is a table
  of contents to its siblings and its entries are real links.
