import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";

// permessage-deflate (RFC 7692) for the sockets that carry text, and only those. A peer link (`/system/<door>/connect`:
// a computer, a phone, the Chrome extension, a runner) carries oRPC JSON: tool results with a file's text, screenshots
// and `devices push` chunks as base64, project deliveries, a runner's patch. Deflate shrinks those frames three- to
// sevenfold, and even a chunk of an already-compressed binary loses base64's third. Every other socket carries bytes
// deflate cannot shrink (H.264 and JPEG frames, PCM audio, a TCP tunnel, SSH), where it would only spend CPU, so their
// offer is dropped before ws reads it and they are never negotiated. A client that offers nothing (Node's own
// WebSocket compresses nothing it sends, but reads deflated frames) is served as before.
const DEFLATED = /^\/system\/[^/]+\/connect$/u;

// Each frame keeps the link's earlier frames as its dictionary (context takeover), the difference between a small
// frame shrinking to a quarter and staying at three quarters. Level 6 deflates 50-100 MB/s, well above any link a peer
// is on; frames under the threshold leave as they are. ws bounds what a frame inflates to by maxPayload, as it bounds an
// unencoded one.
export const PEER_DEFLATE = { threshold: 1024, zlibDeflateOptions: { level: 6 } } as const;

export class PeerDeflateServer extends WebSocketServer {
    constructor() {
        super({ noServer: true, perMessageDeflate: PEER_DEFLATE });
    }

    override handleUpgrade(
        request: IncomingMessage,
        socket: Duplex,
        upgradeHead: Buffer,
        callback: (client: WebSocket, request: IncomingMessage) => void,
    ): void {
        if (!DEFLATED.test(new URL(request.url ?? "/", "http://daemon").pathname)) {
            delete request.headers["sec-websocket-extensions"];
        }
        super.handleUpgrade(request, socket, upgradeHead, callback);
    }
}
