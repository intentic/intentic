import type { IconName } from "@intentic/ui";

// A workspace repo remote, read as a row: the project a clone URL names, the host's page for it, and the host's icon.
// Handles the three address forms git writes (https, ssh, scp); a local path or `file://` address names nothing to link
// to, so it keeps the address as its own label.

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
    // Tried only where the schemed pattern fails: `https://host/owner/repo` matches both, and the schemed reading is
    // correct.
    const matched = schemed ?? /^(?:[^@/]+@)?([^:/]+):([^/].*)$/.exec(address);
    // Trailing slashes come off before `.git`, since a pasted address may carry both in either order.
    const project = (matched?.[2] ?? ``).replace(/^\/+|\/+$/g, ``).replace(/\.git$/i, ``);
    if (matched === null || project === ``) {
        return { project: address, icon: `code` };
    }
    // Any host is assumed to serve a repo at `https://host/<project>` (true of GitLab/Gitea self-installs too), so an
    // unknown host still gets a link, labeled with its own name rather than a guessed one.
    const host = (matched[1] as string).toLowerCase();
    return { project, browseUrl: `https://${host}/${project}`, icon: HOST_ICONS[host] ?? `code` };
};
