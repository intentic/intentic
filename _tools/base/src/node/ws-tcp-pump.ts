// The byte pump between one WebSocket and one TCP socket, both ends of desktop sync's SSH transport: the machine agent
// fronts the sandbox's sshd on a loopback port (ssh → TCP → wss), the daemon carries the socket on to sshd (wss → TCP).
// One protocol, so one set of rules: frames are binary only on both ends (a text frame is dropped, never re-encoded
// into the byte stream), every chunk is copied out of Node's buffer pool before an async send, and each direction
// applies backpressure:
// - TCP → WebSocket: a send never blocks, it buffers. Past BUFFER_HIGH the TCP read pauses (so the writer blocks on its
//   own write) until the WebSocket drains under BUFFER_LOW.
// - WebSocket → TCP: a write that the socket cannot take at once pauses the WebSocket until the socket drains. A
//   WebSocket that cannot pause (the WHATWG one has no such call) is instead dropped once more than UNPAUSABLE_CEILING
//   waits for TCP: a stalled reader costs that stream, which ssh redials, never the process's memory.

export const BUFFER_HIGH = 1_048_576;
export const BUFFER_LOW = 262_144;
export const DRAIN_POLL_MS = 50;
export const UNPAUSABLE_CEILING = 64 * 1_048_576;

// The TCP half: what of a net.Socket the pump uses, so a test can stand one up without a connection.
export interface PumpTcp {
    write(chunk: Uint8Array): boolean;
    pause(): unknown;
    resume(): unknown;
    on(event: "data", listener: (chunk: Buffer) => void): unknown;
    on(event: "drain", listener: () => void): unknown;
    off(event: "data", listener: (chunk: Buffer) => void): unknown;
    off(event: "drain", listener: () => void): unknown;
    readonly writableLength: number;
    readonly destroyed: boolean;
}

// The WebSocket half as either end holds it: the WHATWG socket (machine) or the `ws` one behind hono (daemon).
export interface PumpWebSocket {
    readonly send: (frame: Uint8Array<ArrayBuffer>) => void;
    readonly bufferedAmount: () => number;
    // Stop and restart delivering inbound frames; absent where the WebSocket has no way to.
    readonly pause?: () => void;
    readonly resume?: () => void;
}

// A frame as exactly its own bytes: a view's whole backing buffer would feed the stream neighbouring memory. A text
// frame (a string) is undefined: this protocol is binary only.
export const binaryFrame = (data: unknown): Buffer | undefined => {
    if (Buffer.isBuffer(data)) {
        return data;
    }
    if (data instanceof ArrayBuffer) {
        return Buffer.from(data);
    }
    if (ArrayBuffer.isView(data)) {
        return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    }
    return undefined;
};

// Copies a chunk out of Node's shared Buffer pool: `send` is async, so handing over the pool's memory risks the next
// read overwriting bytes not yet sent, a silent transport corruption.
const frameOf = (chunk: Buffer): Uint8Array<ArrayBuffer> => {
    const frame = new Uint8Array(chunk.byteLength);
    frame.set(chunk);
    return frame;
};

export interface PumpOptions {
    // Read from TCP before the WebSocket opened, sent first and in order.
    readonly queued?: readonly Buffer[];
    // A WebSocket that cannot pause has more than UNPAUSABLE_CEILING waiting for TCP: the caller closes the stream.
    readonly onOverflow: () => void;
    // Overrides UNPAUSABLE_CEILING; a test's knob.
    readonly ceiling?: number;
}

export interface Pump {
    // One inbound WebSocket frame for TCP; a text frame is dropped. False when nothing was written.
    readonly inbound: (data: unknown) => boolean;
    // Stops the drain poll and lets go of the TCP socket's data; the caller closes both ends.
    readonly stop: () => void;
}

// Starts TCP → WebSocket at once (the socket is resumed), and WebSocket → TCP through `inbound`, which the caller feeds
// from whatever message event its WebSocket has.
export const pumpTcpWebSocket = (tcp: PumpTcp, ws: PumpWebSocket, options: PumpOptions): Pump => {
    let drain: NodeJS.Timeout | undefined;
    let wsPaused = false;

    const outbound = (chunk: Buffer): void => {
        ws.send(frameOf(chunk));
        if (drain === undefined && ws.bufferedAmount() > BUFFER_HIGH) {
            tcp.pause();
            drain = setInterval(() => {
                if (ws.bufferedAmount() < BUFFER_LOW) {
                    clearInterval(drain);
                    drain = undefined;
                    tcp.resume();
                }
            }, DRAIN_POLL_MS);
        }
    };

    const resumeWs = (): void => {
        if (wsPaused) {
            wsPaused = false;
            ws.resume?.();
        }
    };

    for (const chunk of options.queued ?? []) {
        outbound(chunk);
    }
    tcp.on("data", outbound);
    tcp.on("drain", resumeWs);
    tcp.resume();

    return {
        inbound: (data) => {
            const bytes = binaryFrame(data);
            if (bytes === undefined || tcp.destroyed) {
                return false;
            }
            if (tcp.write(bytes)) {
                return true;
            }
            if (ws.pause !== undefined && ws.resume !== undefined) {
                if (!wsPaused) {
                    wsPaused = true;
                    ws.pause();
                }
            } else if (tcp.writableLength > (options.ceiling ?? UNPAUSABLE_CEILING)) {
                options.onOverflow();
            }
            return true;
        },
        stop: () => {
            clearInterval(drain);
            drain = undefined;
            tcp.off("data", outbound);
            tcp.off("drain", resumeWs);
        },
    };
};
