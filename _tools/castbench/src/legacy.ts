import type { AddressInfo } from "node:net";
import { BROWSER_VIEW_PATH } from "@intentic/sandbox-contract/browser-wire";
import { type WebSocket, WebSocketServer } from "ws";
import type { Daemon } from "./daemon.js";
import { childrenNamed } from "./proc.js";
import type { Stage } from "./stage.js";

// Today's pipeline, as live-view.ts runs it for one viewer of a window on the video path, with the daemon's own code
// doing every part that costs anything: startVideocast spawns ffmpeg with encoderArgs' exact command line (x11grab of the
// viewport at 30 fps, libx264 ultrafast/zerolatency, CRF 24, 6M maxrate) and splits its output into access units;
// frameGate drops frames while the socket holds a backlog and restarts the encoder for a keyframe once it drains;
// encodeVideo tags each one. Typed text goes in through screencast.ts's dispatchInput (CDP Input.insertText), as
// live-view.ts sends it to a page.
//
// Left out, on purpose: the WebP stills laid over a settled page (stills.ts), a one-off per settle rather than a cost per
// frame, and the window/tab state the socket also carries.

export interface PipelineServer {
    // Where the relay connects to reach it.
    readonly target: { readonly port: number } | { readonly path: string };
    // The address the viewer opens, through the relay listening on `port`.
    readonly url: (port: number) => string;
    readonly protocol: "legacy" | "media";
    // The encoder's processes right now: ffmpeg, one per connected viewer and per restart.
    readonly encoderPids: () => readonly number[];
    // Encoder starts so far: a connection's first, plus one per keyframe restart; null where the pipeline does not
    // restart its encoder to make a keyframe.
    readonly starts: () => number | null;
    readonly close: () => Promise<void>;
}

export const startLegacy = async (daemon: Daemon, stage: Stage): Promise<PipelineServer> => {
    const { encodeVideo, frameGate, startVideocast } = daemon.videocast;
    let starts = 0;
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0, path: BROWSER_VIEW_PATH, perMessageDeflate: false });
    await new Promise<void>((resolve) => server.once("listening", () => resolve()));

    server.on("connection", (ws: WebSocket) => {
        let cast: { readonly stop: () => void } | undefined;
        let stopped = false;
        const region = stage.region;
        const gate = frameGate({ backlog: () => ws.bufferedAmount, restart: () => run() });
        const run = (): void => {
            if (stopped) {
                return;
            }
            cast?.stop();
            gate.started();
            starts += 1;
            cast = startVideocast(stage.display, region, {
                onFrame: (frame) => {
                    if (gate.admit(frame)) {
                        ws.send(encodeVideo(frame, false));
                    }
                },
                onCodec: (codec) => ws.send(JSON.stringify({ type: "ready", kind: "video", width: region.width, height: region.height, scale: region.scale, codec })),
                onExit: (reason) => {
                    if (!stopped) {
                        ws.close(1011, reason.slice(0, 120));
                    }
                },
            });
        };
        ws.on("message", (data, binary) => {
            if (binary) {
                return;
            }
            let message: { type?: string; text?: string };
            try {
                // SAFETY: only `type` and `text` are read, `text` checked to be a string before it is typed.
                message = JSON.parse(String(data)) as typeof message;
            } catch {
                // allow(silent-catch): live-view.ts drops a frame that is not JSON the same way; the viewer sends none.
                return;
            }
            if (message.type === "keyframe") {
                gate.askKey();
            } else if (message.type === "text" && message.text !== undefined) {
                void daemon.screencast
                    .dispatchInput(stage.cdp, { type: "text", text: String(message.text) })
                    // allow(silent-catch): a keystroke the page refused is a missed echo, which the viewer counts.
                    .catch(() => undefined);
            } else if (message.type === "ping") {
                ws.send(JSON.stringify({ type: "pong" }));
            }
        });
        ws.on("close", () => {
            stopped = true;
            cast?.stop();
            gate.stop();
        });
        run();
    });

    // SAFETY: the server listens on a TCP port, so its address is an AddressInfo.
    const { port } = server.address() as AddressInfo;
    return {
        target: { port },
        url: (relay) => `ws://127.0.0.1:${relay}${BROWSER_VIEW_PATH}?session=castbench`,
        protocol: "legacy",
        encoderPids: () => childrenNamed("ffmpeg"),
        starts: () => starts,
        close: async () => {
            for (const client of server.clients) {
                client.terminate();
            }
            await new Promise<void>((resolve) => server.close(() => resolve()));
        },
    };
};
