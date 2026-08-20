import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { type GitHost, gitHostOf } from "../capabilities/cli/git-access.js";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { parseRemote, remoteUrlsOf } from "../git/remote-urls.js";
import { discoverRepos, hasGitEntry } from "../workspace/repo-discovery.js";

/* Which CI project stands behind each workspace repo. A repo is mapped when ANY of its remotes' HOSTNAMES
 * matches a connected github/gitlab capability (github.com is fixed; a gitlab host comes from the capability's
 * instance url, so self-hosted maps too), the capability supplies the token and API base (gitHostOf, the same
 * resolution git access rides). Unmatched repos simply don't participate: no remote, remotes on hosts nobody
 * connected, or a local path are all ordinary states, not errors. */

export interface CiProject {
    // The workspace repo dir ("root" for the workspace repo itself), the id triggers and the view join on.
    readonly repo: string;
    // owner/name (github) or the full namespaced path (gitlab), what the provider API addresses.
    readonly project: string;
    // The connected account serving this repo's host: provider, hostname, REST base, token.
    readonly account: GitHost;
}

// Every workspace repo (the root repo included) whose remote lands on a connected github/gitlab account.
export const ciProjects = async (
    services: { readonly workspace: { readonly root: string }; readonly capabilities: CapabilitiesStore },
    git: GitRunner = defaultGit,
): Promise<CiProject[]> => {
    const accounts: GitHost[] = (await services.capabilities.list()).flatMap((capability) => {
        if (capability.kind !== "cli" || (capability.config.provider !== "github" && capability.config.provider !== "gitlab")) {
            return [];
        }
        try {
            return [gitHostOf(capability.config)];
        } catch {
            // A gitlab capability with an unparseable instance url maps nothing; it fails its own status probe.
            return [];
        }
    });
    if (accounts.length === 0) {
        return [];
    }
    const repos = await discoverRepos(services.workspace.root);
    if (await hasGitEntry(services.workspace.root)) {
        repos.unshift("root");
    }
    const projects: CiProject[] = [];
    for (const repo of repos) {
        const dir = repo === "root" ? services.workspace.root : join(services.workspace.root, repo);
        // First remote that lands on a connected account wins, so a repo keeps its pipelines as long as ONE of
        // its remotes is connected; `origin` leading the order decides it when several are.
        for (const url of await remoteUrlsOf(dir, git)) {
            const remote = parseRemote(url);
            if (remote === undefined) {
                continue;
            }
            const account = accounts.find((candidate) => candidate.host === remote.host);
            if (account !== undefined) {
                projects.push({ repo, project: remote.project, account });
                break;
            }
        }
    }
    return projects;
};
