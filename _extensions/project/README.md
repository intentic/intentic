# @intentic/ext-project

The maker's home: one page per project that says what it is, what is waiting on you, what changed and how to go
back, and which files matter.

## Responsibilities

- Name each project (a repository under the workspace, or the workspace itself when it holds files of its own) and
  say what it is, from its README's first paragraph.
- List what is waiting on the owner: an assistant's draft held for acceptance, one whose changes no longer fit, one
  that asked a question.
- Show what's new as the tree's own restore points, newest first, with the drafted sentence of each landing folded
  onto the point it made, and let any point be gone back to.
- List a project's files with tooling left out, each opening in the workspace's own viewer.
- Offer the ways in: a new project from a sentence, a repository from GitHub, an upload.

## Key files

- [src/timeline.ts](src/timeline.ts): restore points and landings merged into rows, and the day headings over them.
- [src/contentFiles.ts](src/contentFiles.ts): which entries a maker's file list keeps, and a README's summary line.
- [src/useProject.ts](src/useProject.ts): the projects the workspace holds and what each is.
- [src/useTimeline.ts](src/useTimeline.ts): the daemon reads behind the timeline and going back.
- [src/ProjectView.vue](src/ProjectView.vue): the page.
- [src/extension.ts](src/extension.ts): activation, and why the view exists for an empty workspace.

## How it fits

**A home for a different audience, over the same mechanisms.** The workspace tree, the Changes panel and the agents
board are a developer's surfaces. They say branch, land, commit and diff. A person who does not write code needs a
different first page, and the shell's `audience` preference (`api.audience`) is what seats this one where the file
tree was ([docs/design/maker-audience-design.md](../../docs/design/maker-audience-design.md)). Nothing underneath
changes: a landing is still a landing, going back is the daemon's own restore, and every file opens in the same
viewer.

**It reads and starts turns. It does not write files.** Every fact on the page is a daemon answer the workspace
already keeps: `/history/snapshots`, `/agents`, `/workspace/children`, `/workspace/file`. Going back is
`/history/restore`, the same call the developer's Restore points panel makes. A new project is a turn
(`POST /agent`) with the sentence as its brief.

**It is an extension, with the file tree as its stand-in.** Switching it off leaves a maker on the Workspace tile,
which the rail table hands the seat back to (`registry.ts`, `standIn`), so there is never no home.
