import { sandboxRpc } from "../sandbox/sandboxRpc";
import { useEndpoint } from "../sandbox/useEndpoint";
import { scopeQuery, workspaceAgent } from "./workspaceScope";

/* THE ONE DAEMON URL THE BROWSER HANDS TO AN ELEMENT — /workspace/media, for a <video>/<audio> that fetches
 * its own byte ranges.
 *
 * Everything else in this app reaches the daemon through an authenticated fetch and, when the result has to
 * appear in the DOM, a blob: object URL. That works because "the result" is a whole file the tab can hold. A
 * recording is not: it may be gigabytes, its player wants the header, then the trailing index, then whatever
 * window the user just dragged to, and a media element issues those requests ITSELF, with no way to put an
 * Authorization header on any of them.
 *
 * So the credential moves into the URL, and is made small enough to survive being there: POST
 * /workspace/media-ticket authenticates normally and returns a ticket good only for THIS file, so the worst a
 * leaked one buys is the file its holder was already watching (auth/media-tickets.ts). One mint per open,
 * the ticket outlives any plausible sitting, and re-minting mid-playback would mean swapping the element's
 * src, which resets the picture and the position.
 *
 * A daemon too old to mint one 404s, and sandboxClient already turns that into "this sandbox's daemon doesn't
 * provide 'workspace.mediaTicket'" rather than a mystery, which is exactly what the viewer should show.
 */
export const mediaUrl = async (path: string, options: { readonly download?: true } = {}): Promise<string> => {
    // Both halves carry the view's scope (workspaceScope): the mint binds the file it resolves to, and the
    // playback URL has to resolve to that same file or the ticket it carries is refused.
    const agent = workspaceAgent.value;
    const { ticket } = await sandboxRpc.workspace.mediaTicket({ path, agent });
    const base = useEndpoint().daemonBase.value;
    if (base === undefined || base === ``) {
        throw new Error(`Your sandbox isn't reachable yet — finish setup so it registers its address.`);
    }
    const query = scopeQuery(new URLSearchParams({ path, ticket }));
    // Asks the daemon for Content-Disposition: attachment. The `download` ATTRIBUTE cannot do this job, the
    // daemon is a different origin, and a browser ignores the attribute cross-origin and navigates instead.
    if (options.download === true) {
        query.set(`download`, `1`);
    }
    return `${base}/workspace/media?${query.toString()}`;
};
