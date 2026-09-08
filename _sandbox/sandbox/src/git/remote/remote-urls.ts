import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { GitRunner } from "@intentic/scaffold";

// Where a repo's code lives: its remote urls and the host/project each names. Read by two independent callers (CI's
// account mapping, the capability scan) neither of which owns the other, so it lives here.

// Host + project from git's three remote URL forms (https, ssh://, and the scp `git@host:owner/repo` form); anything
// else (a local path, file://) is undefined.
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

// Every remote (`origin` first, not whichever sorts first alphabetically), via one `git remote -v` spawn; cached on
// `.git/config`'s mtime (any write invalidates), skipped for a dir with no local config to stat.
interface CachedRemotes {
    readonly mtimeMs: number;
    readonly urls: readonly string[];
}
const remoteCache = new Map<string, CachedRemotes>();

// The mtime remotes are cached against, or undefined with no local config to watch; never throws, an unreadable repo
// just means "do not cache".
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
        // Cached against the mtime read before the spawn (the safe direction): a write landing in between is stored
        // under the older stamp, so the next call just re-reads instead of serving a stale answer.
        remoteCache.set(dir, { mtimeMs, urls });
    }
    return [...urls];
};

// The first remote that names a host and project, in remoteUrlsOf's order (`origin` wins, so a fork answers as itself,
// not `upstream`); undefined means no usable remote at all.
export const remoteProjectOf = async (dir: string, git: GitRunner): Promise<{ host: string; project: string } | undefined> => {
    for (const url of await remoteUrlsOf(dir, git)) {
        const parsed = parseRemote(url);
        if (parsed !== undefined) {
            return parsed;
        }
    }
    return undefined;
};
