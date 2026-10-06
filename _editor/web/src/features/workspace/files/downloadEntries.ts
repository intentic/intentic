import { basename } from "@intentic/ui/path";
import { sandboxBlob } from "../../../client/sandbox/sandboxClient";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useEndpoint } from "../../../client/endpoint/useEndpoint";
import { scopeQuery, type ViewScope, workspaceScope } from "../../../app/workspaceScope";
import { mediaUrl } from "./mediaUrl";

// Saves workspace entries onto this computer through the browser's own download manager, which streams them to disk:
// nothing is held in the tab, whatever the size. One file downloads as itself (ranged, so a dropped download resumes);
// a folder, or several entries at once, as one ZIP the daemon writes as it reads, deflating only what compresses. A
// backend that mints no tickets offers no ZIP (entryMenu.ts), and hands one file over from its bytes (handBytes).

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

// How long a download's object URL outlives the click that started it, in milliseconds.
const HOLD_MS = 10_000;

// One file from its bytes, for a backend with no media tickets (a folder on this computer, whose file server has only
// /workspace/raw): read whole into the tab, as far as that route's cap, and saved under the file's own name.
const handBytes = async (path: string, scope: ViewScope): Promise<void> => {
    const url = URL.createObjectURL(await sandboxBlob(`/workspace/raw?${scopeQuery(new URLSearchParams({ path }), scope).toString()}`));
    const anchor = document.createElement(`a`);
    anchor.href = url;
    anchor.download = basename(path);
    anchor.click();
    // Held past the click: a browser that starts the download a beat later would otherwise find the bytes gone.
    setTimeout(() => URL.revokeObjectURL(url), HOLD_MS);
};

/** Starts the download; answers the archive's name when it is one, so the caller can say what is on its way. `scope`
 * names whose copy, the Workspace's when absent. */
export const downloadEntries = async (targets: readonly DownloadTarget[], scope: ViewScope = workspaceScope()): Promise<string | undefined> => {
    const [only] = targets;
    if (only === undefined) {
        return undefined;
    }
    if (targets.length === 1 && only.type === `file`) {
        if (supportsRoute(`workspace.mediaTicket`)) {
            hand(await mediaUrl(only.path, { download: true, scope }));
        } else {
            await handBytes(only.path, scope);
        }
        return undefined;
    }
    // The ticket carries the selection, so the URL stays short however much is selected, and the scope rides in it too.
    const { ticket, filename } = await sandboxRpc.workspace.downloadTicket({
        paths: targets.map((target) => target.path),
        agent: scope.agent,
    });
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
    hand(`${base}/workspace/download?${new URLSearchParams({ ticket }).toString()}`);
    return filename;
};
