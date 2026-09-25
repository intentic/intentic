import type { TerminalClientMessage, TerminalServerMessage } from "@intentic/sandbox-contract/browser-wire";
import type { SocketLike } from "./streamSocket";

// A terminal's socket, a WebSocket whichever way it rides: the browser's own over TCP, or one spoken on a stream of the
// edge's WebTransport session (streamSocket.ts). Either delivers the pane's bytes, the server's messages and exactly one
// close, which arrives after `close()` returns.

export interface ChannelEvents {
    readonly open: () => void;
    // Anything at all from the server, which is what proves the channel alive.
    readonly heard: () => void;
    readonly pane: (bytes: Uint8Array) => void;
    readonly message: (message: TerminalServerMessage) => void;
    readonly closed: (code: number, reason: string) => void;
}

export interface TerminalChannel {
    readonly send: (message: TerminalClientMessage) => void;
    readonly close: () => void;
}

// A socket's readyState once it may be written to, as WebSocket.OPEN names it.
const OPEN = 1;

const parse = (text: string): TerminalServerMessage | undefined => {
    try {
        return JSON.parse(text) as TerminalServerMessage;
    } catch {
        // allow(silent-catch): a message that is not JSON is no message; the channel reads on.
        return undefined;
    }
};

export const socketChannel = (socket: SocketLike, events: ChannelEvents): TerminalChannel => {
    // Binary messages arrive as ArrayBuffers, straight to xterm with no Blob copy.
    socket.binaryType = `arraybuffer`;
    socket.addEventListener(`open`, () => events.open());
    socket.addEventListener(`message`, (event) => {
        events.heard();
        const { data } = event as MessageEvent<unknown>;
        if (data instanceof ArrayBuffer) {
            events.pane(new Uint8Array(data));
            return;
        }
        const message = parse(String(data));
        if (message !== undefined) {
            events.message(message);
        }
    });
    socket.addEventListener(`close`, (event) => {
        const { code, reason } = event as CloseEvent;
        events.closed(code, reason);
    });
    return {
        send: (message) => {
            if (socket.readyState === OPEN) {
                socket.send(JSON.stringify(message));
            }
        },
        close: () => socket.close(),
    };
};
