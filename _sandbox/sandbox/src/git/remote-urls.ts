import type { GitRunner } from "@intentic/scaffold";

/* WHERE A REPO'S CODE ACTUALLY LIVES — the remote urls it carries, and the host + project each one names.
 *
 * Two callers need this and they need it for opposite reasons: CI maps a repo onto a connected account, and the
 * capability scan reads the same remotes to notice that nothing is connected yet. Neither owns the other, so it
 * lives here rather than in either.
 */

// hostname + project out of the three remote forms git writes: https://host/owner/repo(.git),
// ssh://git@host[:port]/owner/repo, and the scp form git@host:owner/repo. Anything else (a local path,
// file://) returns undefined — not a remote anything can stand behind.
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
 * configured). The (fetch) url is what `git remote get-url` answers with, and the only one to read. */
export const remoteUrlsOf = async (dir: string, git: GitRunner): Promise<string[]> => {
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
