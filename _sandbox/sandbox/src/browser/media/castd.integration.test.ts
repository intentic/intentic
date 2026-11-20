import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollUntil } from "@intentic/base/async";
import { requires } from "@intentic/testing/requires";
import { MEDIA_FLAGS, MEDIA_HEADER_LEN, MEDIA_KINDS } from "@intentic/sandbox-contract/browser-wire";
import { z } from "zod";
import { browserSessionContext, browserSessionFront, closeBrowserSession } from "../sessions/browser-sessions.js";
import { OWN_BROWSER_SERVER, OWN_BROWSER_SESSION, openOwnBrowser } from "../sessions/own-browser.js";
import { stopSoundServer } from "./cast-audio.js";
import sharp from "sharp";
import { captureSeams, castdScreenshot } from "./agent-capture.js";
import { castdBinary, castdOf, configureCastd } from "./castd.js";
import { startRecording, stopRecording } from "./recordings.js";
import { startLiveView, type LiveView } from "../cast/live-view.js";
import { withMediaRelay } from "./media-relay.js";
import { ensureMediaKey } from "./media-token.js";

/* The person's own window on castd, end to end on this machine: a kiosk Chromium on its display, castd started for it
   when the view opens, the browser view's `media` message, the media socket dialled through the daemon's fallback relay
   with the token it carried, castd's `hello` and a keyframe, and a resize to a box at a pixel ratio of 2 that the screen,
   and the page's viewport, take pixel for pixel. Needs Xvfb, Chromium and a castd build (INTENTIC_CASTD, the image's, or
   `cargo build --release` in _sandbox/castd). */

const playwright = await import("playwright").catch(() => undefined);
const castd = castdBinary();
const machine = requires(
    playwright !== undefined && existsSync(playwright.chromium.executablePath()) && existsSync("/usr/bin/Xvfb") && castd !== undefined,
    "Xvfb, Chromium and a castd build",
    { absentOnCi: "no CI job that runs the daemon's suites installs the browser pack or builds castd; the sandbox image carries both" },
);

const HelloSchema = z.object({ type: z.literal("hello"), width: z.number(), height: z.number(), scale: z.number(), codec: z.string(), readOnly: z.boolean() });
const MediaSchema = z.object({ type: z.literal("media"), path: z.string(), token: z.string(), expiresAt: z.number() });

let dir = "";
let relay: Server;
// Every connection the relay took, ended with it: a relayed media socket is no HTTP exchange `close` would wait out.
const accepted = new Set<Socket>();
let port = 0;
let view: LiveView | undefined;

beforeAll(async () => {
    // A cast directory of the test's own, never the sandbox's: the key, the sockets and the pid files go here.
    dir = mkdtempSync(join(tmpdir(), "castd-it-"));
    configureCastd({ dir, mediaKey: () => ensureMediaKey(dir), startMs: 20_000, recordDir: join(dir, "recordings") });
    // The daemon's HTTP server as a netd older than the media route reaches it: only the relay serves upgrades here.
    relay = createServer((_request, response) => response.writeHead(404).end());
    relay.on("connection", (socket: Socket) => {
        accepted.add(socket);
        socket.once("close", () => accepted.delete(socket));
    });
    withMediaRelay(relay, dir);
    await new Promise<void>((resolve) => relay.listen(0, "127.0.0.1", resolve));
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo.
    port = (relay.address() as AddressInfo).port;
});

afterAll(async () => {
    await view?.stop();
    await closeBrowserSession(OWN_BROWSER_SESSION);
    // The window's sound server, where this machine has PulseAudio: started in the test's directory, ended with it.
    await stopSoundServer(dir);
    for (const socket of accepted) {
        socket.destroy();
    }
    await new Promise<void>((resolve) => relay.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
});

interface Received {
    readonly texts: unknown[];
    readonly binaries: Uint8Array[];
}

const dial = (path: string, token: string, received: Received): Promise<WebSocket> =>
    new Promise((resolve, reject) => {
        const socket = new WebSocket(`ws://127.0.0.1:${port}${path}?token=${encodeURIComponent(token)}`);
        socket.binaryType = "arraybuffer";
        socket.addEventListener("open", () => resolve(socket));
        socket.addEventListener("error", () => reject(new Error(`the media socket at ${path} did not open`)));
        socket.addEventListener("message", (event: MessageEvent) => {
            if (event.data instanceof ArrayBuffer) {
                received.binaries.push(new Uint8Array(event.data));
            } else {
                received.texts.push(JSON.parse(String(event.data)));
            }
        });
    });

const hellos = (received: Received): z.infer<typeof HelloSchema>[] =>
    received.texts.flatMap((text) => {
        const hello = HelloSchema.safeParse(text);
        return hello.success ? [hello.data] : [];
    });

const keyframes = (received: Received): Uint8Array[] =>
    received.binaries.filter((message) => message.length > MEDIA_HEADER_LEN && message[0] === MEDIA_KINDS.video && ((message[1] ?? 0) & MEDIA_FLAGS.key) !== 0);

// Bounds on waits for a real Chromium and a real encoder on a shared machine; none is a latency claim.
const SLOW = { intervalMs: 100, timeoutMs: 30_000 };

test.skipIf(!machine.runs)(
    machine.title("the own window is handed a media socket that castd answers, and a DPR-2 box makes the screen its viewport pixel for pixel"),
    async () => {
        await openOwnBrowser({ root: mkdtempSync(join(tmpdir(), "castd-own-")), warn: () => undefined }, "data:text/html,<title>cast</title><p style='font:20px sans-serif'>castd</p>");
        const context = await browserSessionContext(OWN_BROWSER_SESSION);
        expect(context).not.toBeUndefined();
        const sent: string[] = [];
        view = await startLiveView(
            context!,
            OWN_BROWSER_SERVER,
            { send: (data) => sent.push(data instanceof Uint8Array ? "<binary>" : data) },
            () => undefined,
            { front: { page: () => browserSessionFront(OWN_BROWSER_SESSION), watch: () => () => undefined }, media: true },
        );
        // The browser view socket hands over the media socket, and carries no picture of its own.
        const media = MediaSchema.parse(JSON.parse(sent[0] ?? "{}"));
        expect(media.path).toBe("/system/browser-media/cast-_own");
        expect(sent).not.toContain("<binary>");

        const received: Received = { texts: [], binaries: [] };
        const socket = await dial(media.path, media.token, received);
        expect(await pollUntil(() => hellos(received).length > 0 && keyframes(received).length > 0, SLOW)).toBe(true);
        // Held at the window's default box until a viewer asks for its own (cast-window.ts), from the first picture on.
        expect(hellos(received)[0]).toMatchObject({ width: 1280, height: 880, scale: 1, readOnly: false });
        // The kiosk window fitted to that screen: the page's viewport is the picture.
        const page = browserSessionFront(OWN_BROWSER_SESSION);
        const viewport = async (): Promise<string> => JSON.stringify(await page?.evaluate(() => [window.innerWidth, window.innerHeight, window.devicePixelRatio]));
        await pollUntil(async () => (await viewport()) === JSON.stringify([1280, 880, 1]), SLOW);
        expect(await viewport()).toBe(JSON.stringify([1280, 880, 1]));

        socket.send(JSON.stringify({ type: "resize", width: 640, height: 400, scale: 2 }));
        expect(await pollUntil(() => hellos(received).some((hello) => hello.width === 1280 && hello.height === 800 && hello.scale === 2), SLOW)).toBe(true);
        // The page's viewport is the screen at that ratio: the kiosk fitted to it, xsettingsd giving Chromium the ratio.
        await pollUntil(async () => (await viewport()) === JSON.stringify([640, 400, 2]), SLOW);
        expect(await viewport()).toBe(JSON.stringify([640, 400, 2]));
        socket.close();
    },
    180_000,
);

// What ffprobe reads of a file: its video stream's codec and size, and how long it lasts.
interface Probed {
    readonly codec: string;
    readonly width: number;
    readonly height: number;
    readonly seconds: number;
}

const probed = (file: string): Probed => {
    const out = execFileSync("ffprobe", ["-v", "error", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height:format=duration", "-of", "json", file]);
    const read = z
        .object({ streams: z.array(z.object({ codec_name: z.string(), width: z.number(), height: z.number() })), format: z.object({ duration: z.string() }) })
        .parse(JSON.parse(out.toString("utf8")));
    const stream = read.streams[0];
    return { codec: stream?.codec_name ?? "", width: stream?.width ?? 0, height: stream?.height ?? 0, seconds: Number(read.format.duration) };
};

const probe = requires(machine.runs && existsSync("/usr/bin/ffprobe"), "Xvfb, Chromium, a castd build and ffprobe", {
    absentOnCi: "no CI job that runs the daemon's suites installs the browser pack or builds castd; the sandbox image carries both",
});

test.skipIf(!probe.runs)(
    probe.title("an agent's screenshot of that window is castd's picture at CSS pixels, and three seconds of it record to a playable MP4"),
    async () => {
        const serving = castdOf(OWN_BROWSER_SERVER);
        expect(serving).not.toBeUndefined();
        // Left by the test above at a 640×400 box at a ratio of 2: castd's picture is 1280×800, the page's CSS 640×400.
        const answer = await castdScreenshot(OWN_BROWSER_SERVER, { name: "browser_take_screenshot", arguments: {} }, dir, captureSeams);
        const file = /\]\(([^)]+)\)/u.exec(answer?.content[0]?.type === "text" ? answer.content[0].text : "")?.[1] ?? "";
        const meta = await sharp(readFileSync(file)).metadata();
        expect([meta.width, meta.height, meta.format]).toEqual([640, 400, "png"]);

        const running = await startRecording(serving!);
        expect(running).toMatchObject({ maxSeconds: expect.any(Number) });
        const page = browserSessionFront(OWN_BROWSER_SESSION);
        // Something moving on the page for the recording to hold: a counter, redrawn every 100 ms.
        await page?.evaluate(() => {
            let n = 0;
            setInterval(() => {
                document.body.textContent = String((n += 1));
            }, 100);
        });
        await new Promise((resolve) => setTimeout(resolve, 3_000));
        // castd wrote it as it went, where it was told: the daemon only ever learns where.
        const recorded = await stopRecording(running!);
        expect(recorded?.file.startsWith(join(dir, "recordings"))).toBe(true);
        const read = probed(recorded!.file);
        expect([read.codec, read.width, read.height]).toEqual(["h264", 1280, 800]);
        // Three seconds of wall clock; the stream holds frames only when the screen changed, so allow its edges.
        expect(read.seconds).toBeGreaterThan(2.5);
        expect(read.seconds).toBeLessThan(4);
    },
    120_000,
);
