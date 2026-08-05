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

Memory is native to every sandbox, so the view detects unconditionally — an empty state simply says nothing has
been remembered yet. Same rationale as `ext-logs`: no repo or capability evidence is needed for something the
daemon always has.

## Conventions & gotchas

- The notes are files, not a database. That is what makes them reviewable, greppable, and editable by the agent
  that wrote them without a write API in between.
