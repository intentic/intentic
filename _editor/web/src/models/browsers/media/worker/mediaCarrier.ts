import type { StreamRequest } from "../../../../client/transport/streamSocket";
import type { SocketLike } from "./decodeSeams";

// WHICH WAY THE MEDIA SOCKET RIDES: a WebSocket spoken on a bidirectional stream of the edge's WebTransport session
// where the edge declared one and it is ready, exactly as a terminal's (client/transport/streamSocket.ts: the edge
// serves the stream as one HTTP/1.1 connection, so netd and castd answer it as they answer any WebSocket), else the
// browser's own WebSocket. Nothing in the sandbox changes either way.
//
// Unlike a terminal, which uses a session only once it is ready and never waits for one, the media socket waits up to
// GRACE_MS for a session still opening (2026-11-20): a window's media socket is dialled once and lives as long as the
// window, so the carrier its first dial takes is the one it keeps, where a terminal redials often enough to move over
// on its own. A session that never opened is not waited for again (webTransport.ts `readyTransport`), so a network that
// carries no UDP pays this once.

export const GRACE_MS = 300;

export interface CarrierSeams {
    // The edge's session for `base`'s origin once ready, waiting at most `graceMs`; undefined means a WebSocket now.
    readonly session: (base: string, graceMs: number) => Promise<{ createBidirectionalStream(): Promise<WebTransportBidirectionalStream> } | undefined>;
    readonly webSocket: (url: string) => SocketLike;
    readonly streamSocket: (opening: Promise<WebTransportBidirectionalStream>, request: StreamRequest) => SocketLike;
}

/** The media socket at `url` (ws or wss), on the carrier the edge's declaration and this browser allow. */
export const mediaCarrier =
    (seams: CarrierSeams) =>
    (url: string, transport: boolean): SocketLike | Promise<SocketLike> => {
        if (!transport || !url.startsWith(`wss://`)) {
            return seams.webSocket(url);
        }
        const address = new URL(url);
        return seams.session(`https://${address.host}`, GRACE_MS).then(
            (session) =>
                session === undefined
                    ? seams.webSocket(url)
                    : seams.streamSocket(session.createBidirectionalStream(), { host: address.host, path: address.pathname, query: address.search.slice(1) }),
            // allow(silent-catch): a session that could not be asked for is no session; the WebSocket is every viewer's way in.
            () => seams.webSocket(url),
        );
    };
