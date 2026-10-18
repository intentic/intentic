import { useEndpoint } from "../../../client/endpoint/useEndpoint";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import type { ViewScope } from "../../../app/workspaceScope";

// A workspace web page previewed from the daemon's own address for it (GET /workspace/preview/{ticket}/*, the daemon's
// workspace-preview.ts), so it runs as it would on a static file server: scripts, modules, fetches, workers, the
// internet, links between its pages. The frame and every answer under the ticket are sandboxed without
// `allow-same-origin`, so the page's origin is opaque and it reaches neither this window nor the daemon's API.
// A backend that mints no such address (a folder on this computer, a daemon from before it) previews the sealed
// document htmlDocument.ts builds instead.

// What a frame loads the page from, and the folder its addresses are under, as a workspace path.
export interface PreviewAddress {
    readonly url: string;
    readonly root: string;
}

// Whether this daemon can serve a page for a frame: it advertises the mint, and the editor has its address.
export const canServePreview = (): boolean => {
    const base = useEndpoint().daemonBase.value;
    return supportsRoute(`workspace.previewTicket`) && base !== undefined && base !== ``;
};

// The address for the page at `path` in `scope`; `source` is its unsaved text, served in place of the file.
export const mintPreview = async (path: string, scope: ViewScope, source: string | undefined): Promise<PreviewAddress> => {
    const minted = await sandboxRpc.workspace.previewTicket({ path, agent: scope.agent, source });
    const base = useEndpoint().daemonBase.value ?? ``;
    return { url: `${base}${minted.page}`, root: minted.root };
};

// A path the page told of, relative to the served folder, as the workspace path it names.
export const workspacePathIn = (root: string, path: string): string => (root === `` ? path : `${root}/${path}`);

// The sandbox the frame itself wears, matching what the daemon's answers carry: everything a page does on an ordinary
// origin but `allow-same-origin` (which would hand it this window's) and `allow-top-navigation` (which would let it
// take this window away).
export const SERVED_FRAME_SANDBOX = `allow-scripts allow-forms allow-modals allow-popups allow-popups-to-escape-sandbox allow-downloads allow-pointer-lock allow-presentation`;
