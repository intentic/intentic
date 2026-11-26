import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { remoteUrlsOf } from "../git/remote/remote-urls.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";
import { projectOfRemote } from "./account-outbox.js";

// The projects this workspace could claim (docs/architecture/account-routing.md): each repo's first remote (`origin`
// first), named the way the platform keys claims. A remote here may be the credential broker's loopback address, whose
// payload names the real upstream; projectOfRemote reads both. Read for Settings ▸ Projects' suggestions and the
// `projects suggest` command, so both offer the same list.

export const projectSuggestions = async (root: string, git: GitRunner = defaultGit): Promise<string[]> => {
    const dirs = [root, ...(await discoverRepos(root)).map((repo) => join(root, repo))];
    const found = new Set<string>();
    for (const dir of dirs) {
        const [first] = await remoteUrlsOf(dir, git);
        const project = first === undefined ? undefined : projectOfRemote(first);
        if (project !== undefined) {
            found.add(project);
        }
    }
    return [...found].toSorted();
};
