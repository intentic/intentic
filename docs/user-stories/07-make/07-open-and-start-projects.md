# Open a project, or start one

As someone who does not write code, I want my projects on one screen as tiles, so that opening one shows me only its files and starting a new one is a single press.

The Projects tile on the rail opens a dashboard: one tile per project, with its name and the first line of its README, and a last tile that says New project. I press a project and the workspace opens showing only that project's files, with a chip naming it and a way back to everything. I press New project, keep the name it offers or type my own, and press Create: the project exists, with a README that names it, and it opens.

## Acceptance criteria

- [ ] The dashboard shows one tile per repository in the workspace, and none for the workspace itself
- [ ] A tile shows the project's name and its README's first paragraph, or says there is no description yet
- [ ] Pressing a tile opens the workspace rooted at that project: only its files are listed, and a chip names the folder and returns to the whole workspace
- [ ] New project offers a free name, refuses a name already taken, and on Create makes a repository with a README naming it and one commit, then opens it
- [ ] A workspace with no repositories shows only the New project tile
- [ ] A project that can run is listed under the tiles with a link that opens the Preview area on it
