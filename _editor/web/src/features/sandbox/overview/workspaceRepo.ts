import type { IconName } from "@intentic/ui";

/* THE WORKSPACE REPO AS A ROW READS IT: the project a clone URL names, the host's own page for it, and the mark
 * that host wears. The definition card used to print the remote verbatim in the middle of a sentence, so the one
 * fact anyone wanted from it — which repository this is — arrived as sixty characters ending in `.git`, with no
 * way to follow it.
 *
 * Three address forms, the ones git writes: `https://host/owner/repo(.git)`, `ssh://git@host[:port]/owner/repo`
 * and the scp form `git@host:owner/repo`. A local path or a `file://` address names no repository a reader can
 * open, so it keeps the address as its own label and offers no link rather than a broken one. */

export interface WorkspaceRepo {
    /** `owner/repo`, or the address itself when it names no project. */
    readonly project: string;
    /** The host's page for the repo. Absent when the address is not one a browser can follow. */
    readonly browseUrl?: string;
    readonly icon: IconName;
}

const HOST_ICONS: Record<string, IconName> = { "github.com": `github`, "gitlab.com": `gitlab` };

export const workspaceRepoOf = (remote: string): WorkspaceRepo => {
    const address = remote.trim();
    const schemed = /^(?:https?|ssh|git):\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(address);
    // The scp form has no scheme and splits on a colon, so it is tried only where the schemed one failed:
    // `https://host/owner/repo` matches both patterns and the schemed reading is the right one.
    const matched = schemed ?? /^(?:[^@/]+@)?([^:/]+):([^/].*)$/.exec(address);
    // Slashes come off before `.git` does: a pasted address regularly carries both, and `repo.git/` ends in
    // neither suffix until the other one is gone.
    const project = (matched?.[2] ?? ``).replace(/^\/+|\/+$/g, ``).replace(/\.git$/i, ``);
    if (matched === null || project === ``) {
        return { project: address, icon: `code` };
    }
    /* Both hosts this sandbox can publish to serve a repo at `https://host/<project>`, and so do the
     * self-hosted GitLab and Gitea installs an owner may point at, which is why an unknown host still gets a
     * link. It carries the host's own name, so a wrong guess is visibly a wrong guess rather than a dead end. */
    const host = (matched[1] as string).toLowerCase();
    return { project, browseUrl: `https://${host}/${project}`, icon: HOST_ICONS[host] ?? `code` };
};
