import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { type GitHost, gitHostOf } from "../capabilities/cli/git-access.js";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { discoverRepos, hasGitEntry } from "../workspace/repo-discovery.js";

/* Which CI project stands behind each workspace repo. A repo is mapped when its remote's HOSTNAME matches a
 * connected github/gitlab capability (github.com is fixed; a gitlab host comes from the capability's instance
 * url, so self-hosted maps too) — the capability supplies the token and API base (gitHostOf, the same
 * resolution git access rides). Unmatched repos simply don't participate: no remote, a remote on a host nobody
 * connected, or a local path are all ordinary states, not errors. */

export interface CiProject {
    // The workspace repo dir ("root" for the workspace repo itself) — the id triggers and the view join on.
    readonly repo: string;
    // owner/name (github) or the full namespaced path (gitlab) — what the provider API addresses.
    readonly project: string;
    // The connected account serving this repo's host: provider, hostname, REST base, token.
    readonly account: GitHost;
}

// hostname + project out of the three remote forms git writes: https://host/owner/repo(.git),
// ssh://git@host[:port]/owner/repo, and the scp form git@host:owner/repo. Anything else (a local path,
// file://) returns undefined — not a remote CI can stand behind.
export const parseRemote = (url: string): { host: string; project: string } | undefined => {
    const trimmed = url.trim();
    const schemed = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(trimmed);
    const scp = schemed === null ? /^(?:[^@/]+@)?([^:/]+):([^/].*)$/.exec(trimmed) : null;
    const matched = schemed ?? scp;
    if (matched === null) {
        return undefined;
    }
    const project = (matched[2] as string).replace(/\.git$/, "").replace(/^\/+|\/+$/g, "");
    if (project === "") {
        return undefined;
    }
    return { host: (matched[1] as string).toLowerCase(), project };
};

// The repo's remote url, by remoteState's convention: the first remote `git remote` lists is "the remote this
// repo has". Undefined when the repo has none (or isn't readable as a repo at all).
const remoteUrlOf = async (dir: string, git: GitRunner): Promise<string | undefined> => {
    const listed = await git(dir, ["remote"]).catch(() => undefined);
    const name = listed?.stdout
        .split("\n")
        .find((line) => line.trim() !== "")
        ?.trim();
    if (name === undefined) {
        return undefined;
    }
    const url = await git(dir, ["remote", "get-url", name]).catch(() => undefined);
    const value = url?.stdout.trim();
    return value === undefined || value === "" ? undefined : value;
};

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
        const url = await remoteUrlOf(dir, git);
        const remote = url === undefined ? undefined : parseRemote(url);
        if (remote === undefined) {
            continue;
        }
        const account = accounts.find((candidate) => candidate.host === remote.host);
        if (account !== undefined) {
            projects.push({ repo, project: remote.project, account });
        }
    }
    return projects;
};
