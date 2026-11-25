import { formatBytes } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, onBeforeUnmount, ref } from "vue";
import { scopeQuery, type ViewScope } from "../../../app/workspaceScope";
import { sandboxBlob, sandboxBlobProgress } from "../../../client/sandbox/sandboxClient";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { mediaUrl } from "./mediaUrl";

/* HOW A FILE VIEWER GETS WHAT IT DRAWS, AT ANY SIZE. A viewer that draws from the whole file (a PDF, a picture, a
   document) gets it however large it is (past BLOB_CONFIRM_BYTES on the reader's word, features/workspace/viewers/openFile.ts), and while it
   arrives the wait says how far along it is: a scanned book over a slow link is a wait worth measuring, where a bare
   spinner reads as stuck. That read is let go the moment the tab moves on, rather than finishing a download nobody will
   see. A recording is never read whole: its player streams it in ranges from an address (mediaUrl.ts). */

// A bar from a few megabytes on: a smaller read is over before one could say anything.
const MEASURED_FROM_BYTES = 4 * 1024 * 1024;

export interface Arriving {
    readonly loaded: number;
    // The file's size as the tree knows it; undefined where it does not.
    readonly total: number | undefined;
}

/** `scope` is whose copy the surface reads; `size` the open file's size as the tree knows it, the measured read's total
 *  (an answer's own length is what crossed the wire, which compression shrinks). */
export const useViewerBytes = (scope: () => ViewScope, size: () => number | undefined) => {
    const t = useT();
    // allow(route-literal): the daemon's byte route, read with the bearer, never an address of the app's own pages.
    const rawPath = (target: string): string => `/workspace/raw?${scopeQuery(new URLSearchParams({ path: target }), scope()).toString()}`;
    const read = (target: string): Promise<Blob> => sandboxBlob(rawPath(target));

    const arriving = ref<Arriving>();
    let fetching: AbortController | undefined;
    const stop = (): void => fetching?.abort();
    // The first read of the file on screen, measured as it arrives; any earlier one still out is let go.
    const readMeasured = (target: string): Promise<Blob> => {
        stop();
        fetching = new AbortController();
        const total = size();
        arriving.value = { loaded: 0, total };
        return sandboxBlobProgress(rawPath(target), (loaded) => void (arriving.value = { loaded, total }), { signal: fetching.signal });
    };
    const measured = computed(() => {
        const now = arriving.value;
        if (now === undefined || (now.total ?? now.loaded) < MEASURED_FROM_BYTES) {
            return undefined;
        }
        const loaded = formatBytes(now.loaded);
        return now.total === undefined
            ? { share: undefined, words: t(`workspace.fileViewer.loadedSoFar`, { loaded }) }
            : { share: Math.min(1, now.loaded / now.total), words: t(`workspace.fileViewer.loadedOf`, { loaded, total: formatBytes(now.total) }) };
    });

    // A backend that mints no media tickets (an older file server) plays a recording from its bytes instead, through an
    // object URL held for the one file on screen and let go with it.
    let heldUrl: string | undefined;
    const letGo = (): void => {
        if (heldUrl !== undefined) {
            URL.revokeObjectURL(heldUrl);
            heldUrl = undefined;
        }
    };
    const stream = async (target: string): Promise<string> => {
        if (supportsRoute(`workspace.mediaTicket`)) {
            return mediaUrl(target, { scope: scope() });
        }
        const blob = await read(target);
        letGo();
        heldUrl = URL.createObjectURL(blob);
        return heldUrl;
    };
    onBeforeUnmount(() => {
        stop();
        letGo();
    });

    // Everything held for the file that was on screen, let go as the next one opens.
    const forget = (): void => {
        arriving.value = undefined;
        letGo();
    };
    return { read, readMeasured, measured, stream, stop, forget };
};
