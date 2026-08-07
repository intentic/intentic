# @intentic/ext-memory

What the agent has chosen to remember, as notes you can read and edit.

## Responsibilities

- List the notes the agent has accumulated while working.
- Open one, read it, change it, delete it.

## Key files

- [src/memoryNote.ts](src/memoryNote.ts) — what a note is, and its total parser.
- [src/useMemory.ts](src/useMemory.ts) — reading and writing the note set.
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
