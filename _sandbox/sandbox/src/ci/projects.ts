import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { type GitHost, gitHostOf } from "../capabilities/cli/git-access.js";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { parseRemote, remoteUrlsOf } from "../git/remote/remote-urls.js";
import { discoverRepos, hasGitEntry } from "../workspace/layout/repo-discovery.js";

// Maps each workspace repo to the CI project behind it: mapped when any remote's hostname matches a connected
// github/gitlab capability, which supplies the token and API base (gitHostOf). An unmatched repo (no remote,
// unconnected host, local path) is a normal state, not an error.

export interface CiProject {
    // Workspace repo dir ("root" for the workspace repo itself); the id triggers and the view join on.
    readonly repo: string;
    // owner/name (github) or the full namespaced path (gitlab); what the provider API addresses.
    readonly project: string;
    // The connected account serving this repo's host: provider, hostname, REST base, token.
    readonly account: GitHost;
}

// Every workspace repo (root included) whose remote lands on a connected github/gitlab account.
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
    // First remote landing on a connected account wins; a repo maps if any remote is connected, `origin` first breaks
    // ties.
    const projectFor = async (repo: string): Promise<CiProject[]> => {
        const dir = repo === "root" ? services.workspace.root : join(services.workspace.root, repo);
        for (const url of await remoteUrlsOf(dir, git)) {
            const remote = parseRemote(url);
            if (remote === undefined) {
                continue;
            }
            const account = accounts.find((candidate) => candidate.host === remote.host);
            if (account !== undefined) {
                return [{ repo, project: remote.project, account }];
            }
        }
        return [];
    };
    // Concurrent, not sequential: each repo's read is independent; flat() keeps results in discovery order.
    const found = await Promise.all(repos.map(projectFor));
    return found.flat();
};
