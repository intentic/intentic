import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { useEndpoint } from "../../sandbox/secrets/useEndpoint";
import { workspaceAgent } from "../health/workspaceScope";
import { mediaUrl } from "./mediaUrl";

// Saves workspace entries onto this computer through the browser's own download manager, which streams them to disk:
// nothing is held in the tab, whatever the size. One file downloads as itself (ranged, so a dropped download resumes);
// a folder, or several entries at once, as one ZIP the daemon writes as it reads, deflating only what compresses.

export interface DownloadTarget {
    readonly path: string;
    readonly type: "file" | "dir";
}

// Navigates a detached link rather than the page: an attachment answer never replaces what is on screen.
const hand = (url: string): void => {
    const anchor = document.createElement(`a`);
    anchor.href = url;
    anchor.rel = `noopener`;
    anchor.click();
};

/** Starts the download; answers the archive's name when it is one, so the caller can say what is on its way. */
export const downloadEntries = async (targets: readonly DownloadTarget[]): Promise<string | undefined> => {
    const [only] = targets;
    if (only === undefined) {
        return undefined;
    }
    if (targets.length === 1 && only.type === `file`) {
        hand(await mediaUrl(only.path, { download: true }));
        return undefined;
    }
    // The ticket carries the selection, so the URL stays short however much is selected, and the scope rides in it too.
    const { ticket, filename } = await sandboxRpc.workspace.downloadTicket({
        paths: targets.map((target) => target.path),
        agent: workspaceAgent.value,
    });
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
    hand(`${base}/workspace/download?${new URLSearchParams({ ticket }).toString()}`);
    return filename;
};
