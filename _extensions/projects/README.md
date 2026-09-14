# @intentic/ext-projects

The workspace's repositories as a dashboard of tiles: open one as its own tree, or start a new one in a press.

## Responsibilities

- Draw one tile per repository under the workspace root: its name, a monogram plate in a palette slot fixed by the
  id, its README's first paragraph as one plain line, and a link into the Preview area for a repository that runs.
- Open a tile by making its repository the shell's project scope (`api.workspace.setProject`), which narrows the
  workspace, the agents board and every repository-keyed view to it, then opening the workspace, which roots itself
  there. Say on the tile which project is open, and offer All projects.
- Make a new repository in a press: a free name offered, the daemon's `POST /workspace/repos/new` behind Create,
  and the new project opened.

## Key files

- [src/projects.ts](src/projects.ts): which repositories are tiles, a README's first paragraph turned into one
  clamped line of plain text, the palette slot a tile wears, the free name a press offers, and where a tile goes.
- [src/useProjects.ts](src/useProjects.ts): the daemon reads behind the tiles, and the create call.
- [src/ProjectsView.vue](src/ProjectsView.vue): the dashboard.
- [src/extension.ts](src/extension.ts): activation, and why the view exists for an empty workspace.

## How it fits

**The place the project scope is read and changed.** The tile heads the rail for everyone, above what its scope
narrows ([docs/design/maker-audience-design.md](../../docs/design/maker-audience-design.md), section 12). The
scope itself is the shell's (`app/projectScope.ts`): this extension only sets it and says which project is open,
on its tile's title and the monogram the tile wears in place of its glyph. Nothing here duplicates the Workspace,
which roots itself at the open project and keeps the project's history in its own Restore points panel.

**A tile's summary is plain text, never rendered markup.** A README's first paragraph arrives as whatever its author
wrote — HTML tags, badge rows, links, entities, a bold span with an italic inside it — and a tile has two lines for
it. `summaryOf` reduces that to words and cuts to `SUMMARY_LIMIT`, at a whole sentence where one fits and a whole
word otherwise. Angle brackets that are a placeholder (`*.<zone>`) are text and survive; a `<h1>` is a heading and is
skipped like any other.

**It reads and makes repositories, and does nothing else.** `GET /workspace/repos` lists them, `GET /workspace/file`
reads a README, `POST /workspace/repos/new` makes one. The daemon does the making: a folder, `git init` with its git
dir on `/history` like a clone's, a README that names it, and one commit so agents have a main line to branch from.

**It is an extension, with the file tree as its stand-in.** Switching it off leaves a maker on the Workspace tile,
which the rail table hands the seat back to (`registry.ts`, `standIn`), so there is never no home.
