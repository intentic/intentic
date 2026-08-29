import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunner } from "@intentic/scaffold";

/* WHERE A REPO'S CODE ACTUALLY LIVES, the remote urls it carries, and the host + project each one names.
 *
 * Two callers need this and they need it for opposite reasons: CI maps a repo onto a connected account, and the
 * capability scan reads the same remotes to notice that nothing is connected yet. Neither owns the other, so it
 * lives here rather than in either.
 */

// hostname + project out of the three remote forms git writes: https://host/owner/repo(.git),
// ssh://git@host[:port]/owner/repo, and the scp form git@host:owner/repo. Anything else (a local path,
// file://) returns undefined, not a remote anything can stand behind.
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

/* EVERY remote the repo has, ordered the way a mapping should consider them: `origin` first, then the rest as
 * git lists them. A repo is not limited to one remote and the extra ones are not noise, a host migration leaves
 * the abandoned remote configured for months, and a fork carries `origin` next to `upstream`.
 *
 * Reading only the first remote is what broke this: `git remote` sorts ALPHABETICALLY, so a repo that moved
 * gitlab → github and kept its old `gitlab` remote had that remote win on the letter 'g'. While both accounts
 * were connected the view merely showed the wrong host's pipelines; disconnecting the gitlab capability then
 * dropped the repo out of the mapping entirely, and the board went to "no workspace repo maps to a connected
 * account" for a workspace whose github remote was connected the whole time.
 *
 * One spawn: `git remote -v` prints `name<TAB>url (fetch)` and `(push)` lines per remote (more when a pushurl is
 * configured). The (fetch) url is what `git remote get-url` answers with, and the only one to read.
 *
 * CACHED ON `.git/config`'s MTIME, because that one spawn was ~20% of every git subprocess this daemon runs.
 *
 * Both callers are per-repo and both sit on POLLED routes: the capability scan runs on every GET /capabilities
 * and the CI mapping on every pipelines read, so a workspace of seven repos paid seven spawns per poll, forever,
 * to re-read a file that changes when somebody adds a remote. Measured against the daemon's own perf summary,
 * `git.run` is the highest-frequency op it has (388,471 spawns), and over half of each call's cost is not git at
 * all but the spawn queue and the IPC hop back (`git.run.wait`), so the spawn NOT made is worth much more than
 * the milliseconds git itself would have spent.
 *
 * The mtime is the whole validity rule and it is deliberately coarse: a remote can only appear, change or go by
 * a config write, so any write invalidates, and an unrelated one (a `branch.*.merge` after --set-upstream-to)
 * merely costs the spawn it would have cost anyway. Over-invalidating is free here; under-invalidating would
 * make the CI view point at a host the repo has left, so nothing cleverer than "did the file change" is worth
 * the risk.
 *
 * A dir whose `.git/config` does not stat is NOT cached at all, which is the case that keeps this honest: in a
 * linked worktree `.git` is a FILE naming a gitdir elsewhere, so there is no local config to watch and a cache
 * keyed on the pointer's mtime would go stale silently. Neither caller reads a worktree today; bypassing rather
 * than guessing is what keeps that from becoming a bug when one does. The map is keyed by dir and both callers
 * iterate discovered repos, so it is bounded by the workspace's repo count. */
interface CachedRemotes {
    readonly mtimeMs: number;
    readonly urls: readonly string[];
}
const remoteCache = new Map<string, CachedRemotes>();

// The mtime this dir's remotes are valid against, or undefined when there is no local config to watch (see
// above). Never throws: an unreadable repo is an ordinary state here and answers "do not cache".
const configMtime = async (dir: string): Promise<number | undefined> => {
    const stats = await stat(join(dir, ".git", "config")).catch(() => undefined);
    return stats?.isFile() === true ? stats.mtimeMs : undefined;
};

export const remoteUrlsOf = async (dir: string, git: GitRunner): Promise<string[]> => {
    const mtimeMs = await configMtime(dir);
    if (mtimeMs !== undefined) {
        const hit = remoteCache.get(dir);
        if (hit !== undefined && hit.mtimeMs === mtimeMs) {
            // Copied out: the caller gets an array it may sort or splice without editing the cached answer.
            return [...hit.urls];
        }
    }
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
    const urls = origin === undefined ? rest : [origin, ...rest];
    if (mtimeMs !== undefined) {
        /* Stored against the mtime read BEFORE the spawn, which is the safe direction and worth stating. A write
         * that lands between the two is recorded under the older stamp, so the next call's stat disagrees and
         * simply re-reads: the race costs one extra spawn and can never serve the pre-write answer as current. */
        remoteCache.set(dir, { mtimeMs, urls });
    }
    return [...urls];
};

// WHERE THIS REPO IS, as one answer: the first remote that names a host and a project, in the order above (so
// `origin` wins, and a fork answers with its own fork rather than upstream). Undefined ⇒ no remote, or only
// remotes nothing can stand behind, a repo that exists nowhere anyone else can read.
export const remoteProjectOf = async (dir: string, git: GitRunner): Promise<{ host: string; project: string } | undefined> => {
    for (const url of await remoteUrlsOf(dir, git)) {
        const parsed = parseRemote(url);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
};
