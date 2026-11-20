import { createServer, type Server } from "node:http";
import { existsSync, rmSync } from "node:fs";
import type { BrowserMediaClientMessage, BrowserMediaServerMessage } from "@intentic/sandbox-contract/browser-wire";
import { BROWSER_MEDIA_PATH, MEDIA_KINDS } from "@intentic/sandbox-contract/browser-wire";
import { type WebSocket, WebSocketServer } from "ws";
import { encodeMediaMessage } from "./media-wire.js";

// A stand-in castd: the media protocol's server side over a Unix socket, so the castd adapter and the viewer's media
// wire can be run end to end before castd exists. It is not castd and its numbers mean nothing: its pictures come from
// whatever `source` it is handed (the CLI hands it the daemon's own ffmpeg videocast), it never adapts its rate, and a
// paste reaches it only as the clipboard message, which it ignores, so pastes time out through it.
//
// What it does speak as castd will: `hello` first, naming the codec read off the stream; every picture one message, a
// 16-byte header (rising id, key flag, capture time since hello, one stripe) then the access unit; `pong` echoing a
// ping's `t`; `stats` once a second; a fresh keyframe on `keyframe`; keys typed on the display.

export interface FrameSource {
    // Starts the pictures: `codec` once before the first, then one access unit per call.
    readonly start: (handlers: { readonly onCodec: (codec: string) => void; readonly onFrame: (bytes: Uint8Array, key: boolean) => void }) => { readonly stop: () => void };
}

export interface StubInput {
    readonly type: (text: string) => void;
}

export interface StubOptions {
    readonly socket: string;
    readonly width: number;
    readonly height: number;
    readonly source: FrameSource;
    readonly input: StubInput;
    readonly clock?: () => number;
}

export interface StubCastd {
    // Acks received so far, every connection's.
    readonly acks: () => number;
    readonly close: () => Promise<void>;
}

const send = (ws: WebSocket, message: BrowserMediaServerMessage): void => ws.send(JSON.stringify(message));

const serve = (ws: WebSocket, options: StubOptions, counted: () => void): void => {
    const clock = options.clock ?? Date.now;
    const helloAt = clock();
    let id = 0;
    let sentThisSecond = 0;
    // When each unacknowledged frame went out, for `queueMs`.
    const unacked = new Map<number, number>();
    let stream: { readonly stop: () => void } | undefined;
    const run = (): void => {
        stream?.stop();
        stream = options.source.start({
            onCodec: (codec) => send(ws, { type: "hello", width: options.width, height: options.height, scale: 1, codec, readOnly: false }),
            onFrame: (bytes, key) => {
                id += 1;
                sentThisSecond += 1;
                unacked.set(id, clock());
                ws.send(
                    encodeMediaMessage(
                        { kind: MEDIA_KINDS.video, key, refine: false, id, capturedMs: Math.max(0, clock() - helloAt), stripeTop: 0, stripeIndex: 0, stripeCount: 1 },
                        bytes,
                    ),
                );
            },
        });
    };
    const stats = setInterval(() => {
        const oldest = Math.min(...unacked.values());
        // No round trip of its own (castd pings the viewer; this stand-in does not) and no rate it aims for.
        send(ws, { type: "stats", rttMs: 0, targetKbps: 0, fps: sentThisSecond, queueMs: unacked.size === 0 ? 0 : clock() - oldest });
        sentThisSecond = 0;
    }, 1000);
    ws.on("message", (data, binary) => {
        if (binary) {
            return;
        }
        let message: BrowserMediaClientMessage;
        try {
            // SAFETY: a test double; each branch below reads only the fields its `type` carries in browser-wire.
            message = JSON.parse(String(data)) as BrowserMediaClientMessage;
        } catch {
            // allow(silent-catch): castd ignores a message it cannot parse and keeps the socket open; so does its stand-in.
            return;
        }
        switch (message.type) {
            case "ack":
                counted();
                for (const pending of unacked.keys()) {
                    if (pending <= message.id) {
                        unacked.delete(pending);
                    }
                }
                break;
            case "ping":
                send(ws, { type: "pong", t: message.t });
                break;
            case "keyframe":
                run();
                break;
            case "key":
                // One printable character, unmodified: typed. Chords and named keys are beyond a stand-in.
                if ([...message.key].length === 1 && message.ctrl !== true && message.alt !== true) {
                    options.input.type(message.key);
                }
                break;
            case "text":
                options.input.type(message.text);
                break;
            default:
                break;
        }
    });
    ws.on("close", () => {
        clearInterval(stats);
        stream?.stop();
    });
    run();
};

export const startStubCastd = async (options: StubOptions): Promise<StubCastd> => {
    if (existsSync(options.socket)) {
        rmSync(options.socket);
    }
    let acks = 0;
    const sockets = new WebSocketServer({ noServer: true, perMessageDeflate: false });
    const server: Server = createServer((_request, response) => response.writeHead(426).end());
    server.on("upgrade", (request, socket, head) => {
        const path = new URL(request.url ?? "/", "http://castd").pathname;
        if (!path.startsWith(`${BROWSER_MEDIA_PATH}/`)) {
            socket.destroy();
            return;
        }
        sockets.handleUpgrade(request, socket, head, (ws) =>
            serve(ws, options, () => {
                acks += 1;
            }),
        );
    });
    await new Promise<void>((resolve) => server.listen(options.socket, () => resolve()));
    return {
        acks: () => acks,
        close: async () => {
            for (const client of sockets.clients) {
                client.terminate();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
            rmSync(options.socket, { force: true });
        },
    };
};
