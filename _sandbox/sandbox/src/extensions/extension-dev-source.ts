import { isAbsolute, join, relative, resolve } from "node:path";
import { pathExists } from "@intentic/base/fs";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { extensionIdOf } from "@intentic/extension-manifest";
import { parseRemote } from "../git/remote/remote-urls.js";
import { discoverRepos } from "../workspace/layout/repo-discovery.js";
import { type DevPlace, type DevRoots, worktreesRootOf } from "./extension-dev.js";
import type { InstalledExtension } from "./installed-extensions.js";

// Which install a dev-mode verb means, and which checkout of its source it should run from. Kept apart from the routes:
// the CLI's `extension list` asks the same questions without changing anything.

// A conversation id as the agent's shell reports it; anything else is ignored rather than joined into a path.
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/;

export const callerConversation = (header: string | null | undefined): string | undefined =>
    header !== null && header !== undefined && SEGMENT.test(header) ? header : undefined;

// The install a person means by `id`: its connection id, its manifest id, or its manifest's short name. Only one
// installed from a repository has a pinned copy to stand in for; a built-in or workspace one already runs from source.
export const devTargetOf = (extensions: readonly InstalledExtension[], id: string): InstalledExtension | { readonly refused: string } => {
    const named = (extension: InstalledExtension): boolean =>
        extension.id === id || extensionIdOf(extension.manifest) === id || extension.manifest.name === id;
    const matches = extensions.filter(named);
    const installed = matches.filter((extension) => extension.source === "installed");
    const [only, ...others] = installed;
    if (only !== undefined && others.length === 0) {
        return only;
    }
    if (only !== undefined) {
        return {
            refused: `"${id}" names more than one installed extension (${installed.map((extension) => extension.id).join(", ")}); use one of those ids`,
        };
    }
    const other = matches[0];
    if (other?.source === "builtin") {
        return {
            refused: `${extensionIdOf(other.manifest)} is built into the sandbox image, so there is no installed copy to swap; its source is in the intentic repository`,
        };
    }
    if (other?.source === "workspace") {
        return { refused: `${extensionIdOf(other.manifest)} is written in this workspace and already runs from its source` };
    }
    return { refused: `no installed extension is called "${id}"` };
};

const sameProject = (left: string, right: string): boolean => {
    const a = parseRemote(left);
    const b = parseRemote(right);
    return a !== undefined && b !== undefined && a.host === b.host && a.project.toLowerCase() === b.project.toLowerCase();
};

// Every remote of a checkout by name, in one spawn; a linked worktree reads its main checkout's.
const remotesOf = async (dir: string, git: GitRunner): Promise<Map<string, string>> => {
    const listed = await git(dir, ["config", "--get-regexp", String.raw`^remote\..*\.url$`]).catch(() => undefined);
    const remotes = new Map<string, string>();
    for (const line of (listed?.stdout ?? "").split("\n")) {
        const [, name, url] = /^remote\.(.+)\.url (.+)$/.exec(line.trim()) ?? [];
        if (name !== undefined && url !== undefined) {
            remotes.set(name, url);
        }
    }
    return remotes;
};

// How well a repo answers for the install's address: its origin is it (2), another remote is (1), neither (0).
const matchOf = async (dir: string, url: string, git: GitRunner): Promise<number> => {
    const remotes = await remotesOf(dir, git);
    const origin = remotes.get("origin");
    if (origin !== undefined && sameProject(origin, url)) {
        return 2;
    }
    return [...remotes.values()].some((remote) => sameProject(remote, url)) ? 1 : 0;
};

// The repos of one tree that are checkouts of `url`, best first: origin before another remote, `extensions/` first
// since that is where extensions are kept.
const checkoutsIn = async (tree: string, url: string, git: GitRunner): Promise<string[]> => {
    const scored: { repo: string; score: number }[] = [];
    for (const repo of await discoverRepos(tree)) {
        const score = await matchOf(join(tree, repo), url, git);
        if (score > 0) {
            scored.push({ repo, score: score * 2 + Number(repo.startsWith("extensions/")) });
        }
    }
    return scored.toSorted((a, b) => b.score - a.score).map(({ repo }) => repo);
};

export interface FoundCheckout extends DevPlace {
    // The checkout root, absolute, as the daemon sees it.
    readonly absolute: string;
}

// The checkout of an install's source this workspace holds: the calling conversation's own copy first, then the
// workspace's. Undefined when there is none; `configPath` is not applied, the pointer names the checkout root.
export const sourceCheckoutOf = async (
    roots: DevRoots,
    url: string,
    conversation: string | undefined,
    git: GitRunner = defaultGit,
): Promise<FoundCheckout | undefined> => {
    if (conversation !== undefined) {
        const own = join(worktreesRootOf(roots.historyRoot), conversation);
        if (await pathExists(own)) {
            const [repo] = await checkoutsIn(own, url, git);
            if (repo !== undefined) {
                return { absolute: join(own, repo), path: repo, conversation };
            }
        }
    }
    const [repo] = await checkoutsIn(roots.root, url, git);
    return repo === undefined ? undefined : { absolute: join(roots.root, repo), path: repo };
};

// A path as the caller wrote it, as the daemon must open it. An agent in an isolated conversation sees its own copy of
// the workspace at the workspace's path, so a relative or workspace path from one reads against that copy when the copy
// holds it. A checkout named by its extension's directory inside a larger repository is taken back to the repository
// root, which is what the pointer names (the install's own `path` is applied on top, as for the pinned copy).
export const resolveDevPath = async (
    roots: DevRoots,
    given: string,
    conversation: string | undefined,
    configPath: string | undefined,
): Promise<string> => {
    const trimmed = given.trim().replace(/(.)\/+$/, "$1");
    const own = conversation === undefined ? undefined : join(worktreesRootOf(roots.historyRoot), conversation);
    const ownTree = own !== undefined && (await pathExists(own)) ? own : undefined;
    let path: string;
    if (!isAbsolute(trimmed)) {
        path = ownTree !== undefined && (await pathExists(join(ownTree, trimmed))) ? join(ownTree, trimmed) : resolve(roots.root, trimmed);
    } else if (ownTree !== undefined && (trimmed === roots.root || trimmed.startsWith(`${roots.root}/`))) {
        const inOwn = join(ownTree, relative(roots.root, trimmed));
        path = (await pathExists(inOwn)) ? inOwn : trimmed;
    } else {
        path = trimmed;
    }
    if (configPath !== undefined && path.endsWith(`/${configPath}`) && !(await pathExists(join(path, configPath)))) {
        return path.slice(0, -(configPath.length + 1));
    }
    return path;
};
