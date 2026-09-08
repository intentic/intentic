import { sandboxRpc } from "../../sandbox/client/sandboxRpc";
import { useEndpoint } from "../../sandbox/secrets/useEndpoint";
import { scopeQuery, workspaceAgent } from "../health/workspaceScope";

// Only daemon URL handed straight to an element (/workspace/media): a <video>/<audio> issues its own byte-range
// requests, with no way to add an Authorization header. A short-lived, file-scoped ticket (POST
// /workspace/media-ticket) goes in the URL instead, minted once per open.
export const mediaUrl = async (path: string, options: { readonly download?: true } = {}): Promise<string> => {
    // Both mint and playback carry the view's scope; a URL resolving to a different file has its ticket refused.
    const agent = workspaceAgent.value;
    const { ticket } = await sandboxRpc.workspace.mediaTicket({ path, agent });
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
    const query = scopeQuery(new URLSearchParams({ path, ticket }));
    // Asks for Content-Disposition: attachment; the `download` attribute is ignored cross-origin.
    if (options.download === true) {
        query.set(`download`, `1`);
    }
    return `${base}/workspace/media?${query.toString()}`;
};
