import { join } from "node:path";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { type GitHost, gitHostOf } from "../capabilities/cli/git-access.js";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { discoverRepos, hasGitEntry } from "../workspace/repo-discovery.js";

/* Which CI project stands behind each workspace repo. A repo is mapped when ANY of its remotes' HOSTNAMES
 * matches a connected github/gitlab capability (github.com is fixed; a gitlab host comes from the capability's
 * instance url, so self-hosted maps too) — the capability supplies the token and API base (gitHostOf, the same
 * resolution git access rides). Unmatched repos simply don't participate: no remote, remotes on hosts nobody
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

/* EVERY remote the repo has, ordered the way a CI mapping should consider them: `origin` first, then the rest as
 * git lists them. A repo is not limited to one remote and the extra ones are not noise — a host migration leaves
 * the abandoned remote configured for months, and a fork carries `origin` next to `upstream`.
 *
 * Reading only the first remote is what broke this: `git remote` sorts ALPHABETICALLY, so a repo that moved
 * gitlab → github and kept its old `gitlab` remote had that remote win on the letter 'g'. While both accounts
 * were connected the view merely showed the wrong host's pipelines; disconnecting the gitlab capability then
 * dropped the repo out of the mapping entirely, and the board went to "no workspace repo maps to a connected
 * account" for a workspace whose github remote was connected the whole time.
 *
 * One spawn: `git remote -v` prints `name<TAB>url (fetch)` and `(push)` lines per remote (more when a pushurl is
 * configured). The (fetch) url is what `git remote get-url` answers with, and the only one CI should read. */
const remoteUrlsOf = async (dir: string, git: GitRunner): Promise<string[]> => {
    const listed = await git(dir, ["remote", "-v"]).catch(() => undefined);
    if (listed === undefined) {
        return [];
    }
    const fetchUrls = new Map<string, string>();
    for (const line of listed.stdout.split("\n")) {
        const matched = /^([^\t]+)\t(.+) \(fetch\)$/.exec(line.trim());
        if (matched !== null) {
            fetchUrls.set(matched[1] as string, matched[2] as string);
        }
    }
    const origin = fetchUrls.get("origin");
    const rest = [...fetchUrls].filter(([name]) => name !== "origin").map(([, url]) => url);
    return origin === undefined ? rest : [origin, ...rest];
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
