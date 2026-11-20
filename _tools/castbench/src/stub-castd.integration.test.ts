import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MEDIA_KINDS } from "@intentic/sandbox-contract/browser-wire";
import { WebSocket } from "ws";
import { fillCommand, mediaUrl, mintMediaToken } from "./castd.js";
import { mediaPayload, parseMediaHeader } from "./media-wire.js";
import { startStubCastd, type StubCastd } from "./stub-castd.js";

// The castd side of the media wire as the adapter and the viewer meet it, over a real Unix socket: the stand-in castd
// with a scripted picture source, spoken to by a WebSocket client the way the viewer page speaks. Touches the machine
// (a socket in a temp dir), hence an integration suite.

let dir = "";
let stub: StubCastd | undefined;
const starts: string[] = [];
const typed: string[] = [];

// Two access units per start, the first a keyframe: enough to see ids rise and a restart begin on a key again.
const source = {
    start: (handlers: { readonly onCodec: (codec: string) => void; readonly onFrame: (bytes: Uint8Array, key: boolean) => void }) => {
        starts.push("start");
        handlers.onCodec("avc1.42C028");
        handlers.onFrame(new Uint8Array([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x65]), true);
        handlers.onFrame(new Uint8Array([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x41]), false);
        return { stop: () => undefined };
    },
};

beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), "castbench-stub-"));
    starts.length = 0;
    typed.length = 0;
    stub = await startStubCastd({ socket: join(dir, "castbench.sock"), width: 1280, height: 880, source, input: { type: (text) => typed.push(text) } });
});

afterEach(async () => {
    await stub?.close();
    rmSync(dir, { recursive: true, force: true });
});

// Opens the media socket on the stub's Unix socket and collects what it sends.
const open = async (): Promise<{ readonly ws: WebSocket; readonly text: unknown[]; readonly binary: Uint8Array[]; readonly next: (count: number) => Promise<void> }> => {
    const text: unknown[] = [];
    const binary: Uint8Array[] = [];
    const ws = new WebSocket(`ws+unix://${join(dir, "castbench.sock")}:/system/browser-media/castbench`);
    const waiters: (() => void)[] = [];
    ws.on("message", (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
            binary.push(new Uint8Array(data));
        } else {
            text.push(JSON.parse(String(data)));
        }
        waiters.splice(0).forEach((wake) => wake());
    });
    await new Promise<void>((resolve, reject) => {
        ws.once("open", () => resolve());
        ws.once("error", reject);
    });
    const next = async (count: number): Promise<void> => {
        while (text.length + binary.length < count) {
            await new Promise<void>((resolve) => waiters.push(resolve));
        }
    };
    return { ws, text, binary, next };
};

describe("the stand-in castd's media socket", () => {
    it("opens with hello naming the codec, then one headed message per picture with rising ids", async () => {
        const socket = await open();
        await socket.next(3);
        expect(socket.text[0]).toEqual({ type: "hello", width: 1280, height: 880, scale: 1, codec: "avc1.42C028", readOnly: false });
        const headers = socket.binary.map((message) => parseMediaHeader(message));
        expect(headers.map((header) => [header?.kind, header?.id, header?.key, header?.stripeIndex, header?.stripeCount])).toEqual([
            [MEDIA_KINDS.video, 1, true, 0, 1],
            [MEDIA_KINDS.video, 2, false, 0, 1],
        ]);
        expect([...mediaPayload(socket.binary[1]!)]).toEqual([0, 0, 0, 1, 9, 0xf0, 0, 0, 0, 1, 0x41]);
        socket.ws.close();
    });

    it("echoes a ping's t, counts acks, restarts the picture on keyframe, and types keys", async () => {
        const socket = await open();
        await socket.next(3);
        socket.ws.send(JSON.stringify({ type: "ping", t: 1234.5 }));
        socket.ws.send(JSON.stringify({ type: "ack", id: 2, decodeMs: 1.5 }));
        socket.ws.send(JSON.stringify({ type: "key", key: "a" }));
        socket.ws.send(JSON.stringify({ type: "key", key: "v", ctrl: true }));
        socket.ws.send(JSON.stringify({ type: "keyframe" }));
        // pong, then the restart's hello and its two pictures.
        await socket.next(7);
        expect(socket.text).toContainEqual({ type: "pong", t: 1234.5 });
        expect(stub?.acks()).toBe(1);
        expect(starts).toEqual(["start", "start"]);
        expect(typed).toEqual(["a"]);
        expect(parseMediaHeader(socket.binary[2]!)).toMatchObject({ id: 3, key: true });
        socket.ws.close();
    });
});

describe("the castd adapter's addressing", () => {
    it("fills a command's placeholders from the stage", () => {
        expect(
            fillCommand("castd --display {display} --socket {socket} --session {session} --key-file {keyfile} --size {width}x{height} --crop {region}", {
                display: ":201",
                socket: "/run/intentic/cast/s.sock",
                session: "s",
                keyFile: "/tmp/k",
                region: { x: 1280, y: 720, width: 1280, height: 880 },
            }),
        ).toBe("castd --display :201 --socket /run/intentic/cast/s.sock --session s --key-file /tmp/k --size 1280x880 --crop 1280,720,1280,880");
    });

    it("mints the token castd's src/token.rs checks, matching its test vector", () => {
        expect(mintMediaToken(Buffer.from("castd-test-key"), "browser-own", 1_893_456_000_000, false)).toBe(
            "eyJzIjoiYnJvd3Nlci1vd24iLCJleHAiOjE4OTM0NTYwMDAwMDAsInJvIjpmYWxzZX0.YKTUvxiTZMF1qntsiKCawvxUDDzjYqLIgo9u7ovM2yU",
        );
    });

    it("opens /system/browser-media/<session>, with the token only when there is one", () => {
        expect(mediaUrl(4000, "own", "t0k=n")).toBe("ws://127.0.0.1:4000/system/browser-media/own?token=t0k%3Dn");
        expect(mediaUrl(4000, "own", undefined)).toBe("ws://127.0.0.1:4000/system/browser-media/own");
    });
});
