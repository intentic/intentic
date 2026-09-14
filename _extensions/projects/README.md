# @intentic/ext-projects

The workspace's repositories as a dashboard of tiles: open one as its own tree, or start a new one in a press.

## Responsibilities

- Draw one tile per repository under the workspace root, with its name, its README's first paragraph, and whether
  the Preview area can show it running.
- Open a tile as the Workspace rooted at that repository (`/workspace?dir=<repo>`), the same address the phone's
  drill-down reads.
- Make a new repository in a press: a free name offered, the daemon's `POST /workspace/repos/new` behind Create,
  and the new project opened.

## Key files

- [src/projects.ts](src/projects.ts): which repositories are tiles, a README's summary line, the free name a press
  offers, and where a tile goes.
- [src/useProjects.ts](src/useProjects.ts): the daemon reads behind the tiles, and the create call.
- [src/ProjectsView.vue](src/ProjectsView.vue): the dashboard.
- [src/extension.ts](src/extension.ts): activation, and why the view exists for an empty workspace.

## How it fits

**A home for a different audience, over the same Workspace.** The shell's `audience` preference seats this tile
where a developer has the file tree ([docs/design/maker-audience-design.md](../../docs/design/maker-audience-design.md)).
Nothing here duplicates the Workspace: a tile opens it, rooted at one folder (`health/workspaceScope.ts`,
`workspaceDir`), and the Workspace's own Restore points panel is the project's history.

**It reads and makes repositories, and does nothing else.** `GET /workspace/repos` lists them, `GET /workspace/file`
reads a README, `POST /workspace/repos/new` makes one. The daemon does the making: a folder, `git init` with its git
dir on `/history` like a clone's, a README that names it, and one commit so agents have a main line to branch from.

**It is an extension, with the file tree as its stand-in.** Switching it off leaves a maker on the Workspace tile,
which the rail table hands the seat back to (`registry.ts`, `standIn`), so there is never no home.
