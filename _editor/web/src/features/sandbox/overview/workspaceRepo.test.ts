import { expect, it } from "vitest";
import { workspaceRepoOf } from "./workspaceRepo";

/* The row's title and its one link both come from here, so a wrong answer is either a repository the reader
 * cannot identify or a link that opens nothing. */

it("names the project and links the host's page for the https form", () => {
    expect(workspaceRepoOf(`https://github.com/radarsu/intentic-sandbox-0738cd.git`)).toEqual({
        project: `radarsu/intentic-sandbox-0738cd`,
        browseUrl: `https://github.com/radarsu/intentic-sandbox-0738cd`,
        icon: `github`,
    });
    expect(workspaceRepoOf(`https://gitlab.com/team/shop-api`).icon).toBe(`gitlab`);
});

it("reads the two ssh forms, whose credentials and port are not part of the project", () => {
    expect(workspaceRepoOf(`git@github.com:radarsu/notes.git`)).toEqual({
        project: `radarsu/notes`,
        browseUrl: `https://github.com/radarsu/notes`,
        icon: `github`,
    });
    expect(workspaceRepoOf(`ssh://git@gitlab.com:2222/team/shop-api.git`).browseUrl).toBe(`https://gitlab.com/team/shop-api`);
});

it("links an unknown host too: a self-hosted GitLab or Gitea serves the same path, under the generic mark", () => {
    expect(workspaceRepoOf(`https://git.acme.internal/platform/tools.git`)).toEqual({
        project: `platform/tools`,
        browseUrl: `https://git.acme.internal/platform/tools`,
        icon: `code`,
    });
});

it("keeps the address as its own label where nothing can be opened", () => {
    expect(workspaceRepoOf(`/srv/git/workspace`)).toEqual({ project: `/srv/git/workspace`, icon: `code` });
    expect(workspaceRepoOf(`  file:///srv/git/workspace  `)).toEqual({ project: `file:///srv/git/workspace`, icon: `code` });
    expect(workspaceRepoOf(`https://github.com/`)).toEqual({ project: `https://github.com/`, icon: `code` });
});

it("ignores casing and the trailing slashes a paste brings", () => {
    expect(workspaceRepoOf(`  https://GitHub.com/radarsu/notes.GIT/  `).browseUrl).toBe(`https://github.com/radarsu/notes`);
});
