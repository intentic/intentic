import { parseJsonWith } from "@intentic/base/json";
import type { TerminalClientMessage, TerminalServerMessage } from "@intentic/sandbox-contract/browser-wire";
import { z } from "zod";
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

// Whether this browser can read deflated pane bytes, which is what asking netd for them (`deflate=1`) promises.
export const readsDeflate = (): boolean => `DecompressionStream` in globalThis;

// The most one deflated message may unpack to: netd sends at most 256 KiB a message, and nothing is let inflate past this.
const MAX_UNPACKED = 16 * 1024 * 1024;

// The pane's bytes as netd deflates them once it has said `deflate` (netd term/deflate.rs): one inflate stream for the
// socket, each message its unpacked length (4 bytes, big-endian) then raw deflate through a sync flush. The length is
// what lets an asynchronous DecompressionStream hand back each message whole: exactly that many bytes are read out
// before the next message goes in.
const inflater = (): ((message: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>) => {
    const stream = new DecompressionStream(`deflate-raw`);
    const writer = stream.writable.getWriter();
    const reader = stream.readable.getReader();
    return async (message) => {
        if (message.byteLength < 4) {
            throw new Error(`a deflated pane message with no length`);
        }
        const length = new DataView(message.buffer, message.byteOffset, 4).getUint32(0);
        if (length > MAX_UNPACKED) {
            throw new Error(`a deflated pane message that unpacks to ${length} bytes`);
        }
        // Not awaited: the write settles as the bytes are read out below.
        // allow(silent-catch): a write that fails errors the stream, and the read below rejects with that same error
        writer.write(message.subarray(4)).catch(() => undefined);
        const unpacked = new Uint8Array(length);
        let filled = 0;
        while (filled < length) {
            // one stream, read in order
            const { value, done } = await reader.read();
            if (done || value.byteLength > length - filled) {
                throw new Error(`a deflated pane message that does not unpack to the length it gave`);
            }
            unpacked.set(value, filled);
            filled += value.byteLength;
        }
        return unpacked;
    };
};

// Validate at the socket boundary so newer message kinds and malformed grids cannot disturb xterm.
const cells = z.number().int().min(1).max(65_535);
const ServerMessageSchema: z.ZodType<TerminalServerMessage> = z.discriminatedUnion(`type`, [
    z.object({ type: z.literal(`pong`) }),
    z.object({ type: z.literal(`exit`), code: z.number().int(), reason: z.string().optional() }),
    z.object({ type: z.literal(`grid`), cols: cells, rows: cells }),
    z.object({ type: z.literal(`deflate`) }),
]);

const parse = (text: string): TerminalServerMessage | undefined => {
    // A message that is not JSON is no message; the channel reads on.
    return parseJsonWith(text, ServerMessageSchema);
};

export const socketChannel = (socket: SocketLike, events: ChannelEvents): TerminalChannel => {
    // Binary messages arrive as ArrayBuffers, straight to xterm with no Blob copy.
    socket.binaryType = `arraybuffer`;
    // Set once netd says `deflate`. From then on every event waits its turn behind the inflating before it, so a grid,
    // an exit or the close never overtakes pane bytes still being unpacked; a message that will not unpack ends the
    // socket, whose redial starts a fresh stream.
    let inflate: ((message: Uint8Array<ArrayBuffer>) => Promise<Uint8Array>) | undefined;
    let turn: Promise<void> = Promise.resolve();
    // Before any inflating, at once, exactly as a raw socket always delivered.
    const inOrder = (work: () => void | Promise<void>): void => {
        if (inflate === undefined) {
            void work();
            return;
        }
        turn = turn.then(work).catch(() => socket.close());
    };
    socket.addEventListener(`open`, () => events.open());
    socket.addEventListener(`message`, (event) => {
        events.heard();
        const { data } = event as MessageEvent<unknown>;
        const unpack = inflate;
        if (data instanceof ArrayBuffer) {
            inOrder(async () => events.pane(unpack === undefined ? new Uint8Array(data) : await unpack(new Uint8Array(data))));
            return;
        }
        const message = parse(String(data));
        if (message?.type === `deflate`) {
            inflate = inflater();
        } else if (message !== undefined) {
            inOrder(() => events.message(message));
        }
    });
    socket.addEventListener(`close`, (event) => {
        const { code, reason } = event as CloseEvent;
        inOrder(() => events.closed(code, reason));
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
