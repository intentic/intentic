// A terminal's messages on a stream no WebSocket rides (a WebTransport one): a kind byte, a big-endian u32 length, then
// that many bytes, one WebSocket message's worth each. The front's Rust codec reads the fixture this file's test reads.

import type { TerminalUpgrade } from "./generated/wire.js";

export const TERMINAL_UPGRADE: TerminalUpgrade = "intentic-terminal";

// Where a browser opens its WebTransport session, on the address of the sandbox the session's streams reach; the edge
// answers it, never the sandbox.
export const WEBTRANSPORT_PATH = "/system/transport";

const HEADER_BYTES = 5;

// Indexed by the kind byte.
const KINDS = ["pane", "message", "close", "ping", "pong"] as const;

export type TerminalFrame =
    | { readonly kind: "pane" | "ping" | "pong"; readonly bytes: Uint8Array }
    | { readonly kind: "message"; readonly text: string }
    // No code is a close that names none, as a WebSocket's may.
    | { readonly kind: "close"; readonly code?: number; readonly reason: string };

const utf8 = new TextEncoder();
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

const payloadOf = (frame: TerminalFrame): Uint8Array => {
    switch (frame.kind) {
        case "message":
            return utf8.encode(frame.text);
        case "close": {
            if (frame.code === undefined) {
                return new Uint8Array(0);
            }
            const reason = utf8.encode(frame.reason);
            const payload = new Uint8Array(2 + reason.length);
            new DataView(payload.buffer).setUint16(0, frame.code);
            payload.set(reason, 2);
            return payload;
        }
        default:
            return frame.bytes;
    }
};

export const encodeTerminalFrame = (frame: TerminalFrame): Uint8Array => {
    const payload = payloadOf(frame);
    const encoded = new Uint8Array(HEADER_BYTES + payload.length);
    encoded[0] = KINDS.indexOf(frame.kind);
    new DataView(encoded.buffer).setUint32(1, payload.length);
    encoded.set(payload, HEADER_BYTES);
    return encoded;
};

const frameOf = (kind: (typeof KINDS)[number], payload: Uint8Array): TerminalFrame => {
    switch (kind) {
        case "message":
            return { kind, text: strictUtf8.decode(payload) };
        case "close": {
            if (payload.length === 0) {
                return { kind, reason: "" };
            }
            if (payload.length < 2) {
                throw new Error("a close frame's code is two bytes");
            }
            const code = new DataView(payload.buffer, payload.byteOffset, 2).getUint16(0);
            return { kind, code, reason: strictUtf8.decode(payload.subarray(2)) };
        }
        default:
            return { kind, bytes: payload };
    }
};

// Whole frames out of a stream's chunks however the chunks cut them. Throws on a kind, a length past `maxBytes` or a
// payload no front sends, since nothing after it on the stream can be framed.
export const terminalFrameReader = (maxBytes: number): ((chunk: Uint8Array) => TerminalFrame[]) => {
    let pending = new Uint8Array(0);
    return (chunk) => {
        const joined = new Uint8Array(pending.length + chunk.length);
        joined.set(pending);
        joined.set(chunk, pending.length);
        const view = new DataView(joined.buffer);
        const frames: TerminalFrame[] = [];
        let at = 0;
        while (joined.length - at >= HEADER_BYTES) {
            const kind = KINDS[joined[at] ?? KINDS.length];
            if (kind === undefined) {
                throw new Error(`no terminal frame is of kind ${joined[at]}`);
            }
            const length = view.getUint32(at + 1);
            if (length > maxBytes) {
                throw new Error(`a terminal frame of ${length} bytes is past ${maxBytes}`);
            }
            if (joined.length - at - HEADER_BYTES < length) {
                break;
            }
            frames.push(frameOf(kind, joined.subarray(at + HEADER_BYTES, at + HEADER_BYTES + length)));
            at += HEADER_BYTES + length;
        }
        pending = joined.slice(at);
        return frames;
    };
};
