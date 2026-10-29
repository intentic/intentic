import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useEndpoint } from "../../../client/endpoint/useEndpoint";
import { elementAddress } from "../../../client/endpoint/elementAddress";
import { scopeFields, scopeQuery, type ViewScope, workspaceScope } from "../../../app/workspaceScope";

// Only daemon URL handed straight to an element (/workspace/media): a <video>/<audio> issues its own byte-range
// requests, with no way to add an Authorization header. A short-lived, file-scoped ticket (POST
// /workspace/media-ticket) goes in the URL instead, minted once per open. Handed over as the host names it
// (elementAddress.ts), since the element, not the editor's transport, requests it.
export const mediaUrl = async (path: string, options: { readonly download?: true; readonly scope?: ViewScope } = {}): Promise<string> => {
    // Both mint and playback carry the view's scope; a URL resolving to a different file has its ticket refused.
    const scope = options.scope ?? workspaceScope();
    const { ticket } = await sandboxRpc.workspace.mediaTicket({ path, ...scopeFields(scope) });
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(`Your sandbox isn't reachable yet: finish setup so it registers its address.`);
    }
    const query = scopeQuery(new URLSearchParams({ path, ticket }), scope);
    // Asks for Content-Disposition: attachment; the `download` attribute is ignored cross-origin.
    if (options.download === true) {
        query.set(`download`, `1`);
    }
    return elementAddress(`${base}/workspace/media?${query.toString()}`);
};
