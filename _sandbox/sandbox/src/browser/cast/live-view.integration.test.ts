import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { z } from "zod";
import { chromiumWindowArgs, DISPLAY_HEIGHT, DISPLAY_WIDTH, ensureDisplay, releaseDisplay } from "./display.js";
import { startLiveView, type LiveReady, type LiveView } from "./live-view.js";
import { readRegion } from "./region.js";
import { FRAME_JPEG, FRAME_WEBP } from "./screencast.js";
import { QUIET_BYTES } from "./stills.js";
import { FRAME_H264_DELTA, FRAME_H264_DELTA_QUIET, FRAME_H264_KEY, FRAME_H264_KEY_QUIET } from "./videocast.js";

// The video path end to end on a real display: Chromium headed on Xvfb, ffmpeg grabbing it, the daemon's own view
// over a fake socket. Skips where the browser pack is not installed. What it pins is what no unit can: that the
// region read off the page is the picture's size, that a still follows a settled page and the frames after it are
// quiet, and that a resize and a navigation from the client's chrome land.

const DISPLAY_KEY = "live-view-test";
const SCREEN = { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };

interface Wire {
    readonly json: object[];
    readonly tags: number[];
    // Each picture's size on the wire, tag byte included, in step with `tags`.
    readonly sizes: number[];
    // Each still's WebP bytes, tag byte stripped.
    readonly stills: Uint8Array[];
}

// `debugging` adds Chromium's DevTools HTTP endpoint beside Playwright's pipe, as the daemon's own browsers have one.
const launch = async (debugging = false): Promise<{ context: BrowserContext; profile: string } | undefined> => {
    let playwright: typeof import("playwright");
    try {
        playwright = await import("playwright");
    } catch {
        return undefined; // the package isn't installed
    }
    const executablePath = playwright.chromium.executablePath();
    if (!existsSync(executablePath)) {
        return undefined; // installed, but the binary isn't on disk
    }
    // Own display via ensureDisplay's key, since sharing one with a daemon's browsers would overlap.
    const display = await ensureDisplay(DISPLAY_KEY).catch(() => undefined);
    if (display === undefined) {
        return undefined; // no Xvfb
    }
    const profile = mkdtempSync(join(tmpdir(), "live-view-test-"));
    const context = await playwright.chromium
        .launchPersistentContext(profile, {
            executablePath,
            headless: false,
            viewport: null,
            env: { ...process.env, DISPLAY: display.name },
            args: ["--no-sandbox", "--disable-dev-shm-usage", ...(debugging ? ["--remote-debugging-port=0"] : []), ...chromiumWindowArgs(display)],
        })
        .catch(() => undefined);
    if (context === undefined) {
        rmSync(profile, { recursive: true, force: true });
        return undefined;
    }
    return { context, profile };
};

// The endpoint a launch with --remote-debugging-port=0 wrote into its profile: the port on the first line.
const endpointOf = async (profile: string): Promise<string> => {
    const file = join(profile, "DevToolsActivePort");
    await settle(() => existsSync(file) && readFileSync(file, "utf8").includes("\n"));
    return `http://127.0.0.1:${readFileSync(file, "utf8").split("\n")[0] ?? ""}`;
};

// Polls for a condition rather than sleeping a guess; generous but finite, so a regression fails rather than hangs.
const settle = async (until: () => boolean, ms = 30_000): Promise<void> => {
    for (let waited = 0; waited < ms && !until(); waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

const readies = (wire: Wire): LiveReady[] => wire.json.filter((message): message is LiveReady => (message as { type?: string }).type === "ready");

// The first `ready` is the viewport as the page itself reports it, in the display's pixels, below the toolbar.
const expectViewport = async (wire: Wire, page: Page): Promise<number> => {
    await settle(() => readies(wire).length > 0);
    const read = await readRegion(page, SCREEN);
    if (read === undefined) {
        throw new Error("the page reported no geometry");
    }
    expect(readies(wire)[0]).toMatchObject({
        kind: "video",
        width: read.region.width,
        height: read.region.height,
        scale: read.region.scale,
        codec: expect.stringMatching(/^avc1\./),
    });
    expect(read.region.y).toBeGreaterThan(read.geometry.screenY * read.region.scale);
    return read.region.scale;
};

// A keyframe starts the stream; a still follows the settle, and the frames after it are quiet.
const expectSharpened = async (wire: Wire): Promise<void> => {
    await settle(() => wire.tags.includes(FRAME_H264_KEY));
    await settle(() => wire.tags.includes(FRAME_WEBP));
    const stillAt = wire.tags.indexOf(FRAME_WEBP);
    expect(stillAt).toBeGreaterThan(-1);
    await settle(() => wire.tags.slice(stillAt).some((tag) => tag === FRAME_H264_KEY_QUIET || tag === FRAME_H264_DELTA_QUIET));
    expect(wire.tags.slice(stillAt).some((tag) => tag === FRAME_H264_KEY_QUIET || tag === FRAME_H264_DELTA_QUIET)).toBe(true);
};

interface PixelSize {
    readonly width: number;
    readonly height: number;
}

// A WebP's canvas size off its header: the extended (VP8X), lossless (VP8L) and lossy (VP8) layouts.
const webpSize = (bytes: Uint8Array): PixelSize => {
    const view = Buffer.from(bytes);
    const chunk = view.subarray(12, 16).toString("latin1");
    if (chunk === "VP8X") {
        return { width: 1 + view.readUIntLE(24, 3), height: 1 + view.readUIntLE(27, 3) };
    }
    if (chunk === "VP8L") {
        const bits = view.readUInt32LE(21);
        return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >> 14) & 0x3fff) };
    }
    return { width: view.readUInt16LE(26) & 0x3fff, height: view.readUInt16LE(28) & 0x3fff };
};

// The still is the picture's own rectangle at the display's pixels, and taking it moves nothing on the display. A still
// clipped at another scale made Chromium re-render the live window zoomed while it was taken, which the grab filmed as a
// frame of motion: the page flashed at twice its size on every still.
const expectStillUnfelt = (wire: Wire): void => {
    const ready = readies(wire)[0];
    const still = wire.stills[0];
    if (ready === undefined || still === undefined) {
        throw new Error("no picture, or no still, to compare");
    }
    const size = webpSize(still);
    // The viewport's own height can be a pixel more than the picture's, which is kept even for the encoder.
    expect([size.width, size.height - (size.height % 2)]).toEqual([ready.width, ready.height]);
    // The page holds still, so for a second after the still every delta is too small to be motion. Only after: the still
    // is taken once the page has settled, but a starved encoder can deliver the page's first paint late, close before
    // it. A zoomed re-render shows after it too, as the window zooms back.
    const stillAt = wire.tags.indexOf(FRAME_WEBP);
    const after = wire.tags
        .map((tag, index) => ({ tag, bytes: wire.sizes[index] ?? 0, index }))
        .filter(({ index, tag }) => index > stillAt && index <= stillAt + 30 && (tag === FRAME_H264_DELTA || tag === FRAME_H264_DELTA_QUIET));
    expect(after.filter(({ bytes }) => bytes > QUIET_BYTES)).toEqual([]);
};

// A resize from the client's box is a fresh stream at that size, and the page's viewport is that size.
const expectResized = async (view: LiveView, wire: Wire, page: Page, scale: number): Promise<void> => {
    await view.input({ type: "resize", width: 900, height: 600 });
    await settle(() => readies(wire).some((ready) => ready.width === 900 * scale && ready.height === 600 * scale));
    const after = await readRegion(page, SCREEN);
    expect([after?.geometry.innerWidth, after?.geometry.innerHeight]).toEqual([900, 600]);
};

// The chrome's verbs reach the page: a new tab is what the view shows, a navigation moves it.
const expectSteered = async (view: LiveView, page: Page): Promise<void> => {
    await view.input({ type: "newTab", url: "data:text/html,<title>two</title>two" });
    await settle(() => view.page() !== page);
    const opened = view.page();
    await settle(() => opened?.url().includes("two") === true);
    expect(opened?.url()).toContain("two");
    await view.input({ type: "navigate", url: "data:text/html,<title>three</title>three" });
    await settle(() => opened?.url().includes("three") === true);
    expect(opened?.url()).toContain("three");
};

afterAll(() => releaseDisplay(DISPLAY_KEY));

/* A phone on the view (emulation.ts). The page is a phone's screen with a mark in each corner and a button near the
   bottom: a click in the picture's pixels must land on what it was aimed at through the shrinking, and the corner marks
   (6 CSS px, smaller than any border or chrome the picture could wrongly hold) are only hit if the picture is the
   device's screen to the pixel. */

const PHONE = { width: 390, height: 844, mobile: true, userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Mobile/15E148" } as const;

const PHONE_PAGE = `data:text/html,${encodeURIComponent(
    "<meta name=viewport content='width=device-width,initial-scale=1'><title>phone</title>" +
        "<body style='margin:0;background:#fff'>" +
        "<div id=tl style='position:fixed;left:0;top:0;width:6px;height:6px;background:#0a0'></div>" +
        "<div id=br style='position:fixed;right:0;bottom:0;width:6px;height:6px;background:#0a0'></div>" +
        "<button id=go style='position:absolute;left:300px;top:700px;width:80px;height:60px'>go</button>" +
        "<script>addEventListener('mousedown', (event) => { document.title = (event.target.id || 'page') + ' ' + event.clientX + ',' + event.clientY; });</script>",
)}`;

interface Seen {
    readonly width: number;
    readonly height: number;
    readonly touch: number;
    readonly agent: string;
}

const seen = (page: Page): Promise<Seen> =>
    page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, touch: navigator.maxTouchPoints, agent: navigator.userAgent }));

// A press and release at a point of the picture, and what the page says was under it.
const tap = async (view: LiveView, page: Page, x: number, y: number): Promise<string> => {
    await page.evaluate(() => {
        document.title = "";
    });
    await view.input({ type: "mouse", action: "down", x, y, button: 0, buttons: 1, clickCount: 1 });
    await view.input({ type: "mouse", action: "up", x, y, button: 0, buttons: 0, clickCount: 1 });
    await settle(() => false, 400);
    return await page.title();
};

const fitOf = (ready: LiveReady | undefined): number => (ready === undefined ? 1 : ready.height / ready.scale / PHONE.height);

// Taps the two corner marks and the button, in the picture's own pixels: each must name what it hit.
const expectAimed = async (view: LiveView, page: Page, ready: LiveReady): Promise<void> => {
    const fit = fitOf(ready);
    const width = ready.width / ready.scale;
    const height = ready.height / ready.scale;
    expect(await tap(view, page, 2 * ready.scale, 2 * ready.scale)).toMatch(/^tl /);
    expect(await tap(view, page, (width - 2) * ready.scale, (height - 2) * ready.scale)).toMatch(/^br /);
    const button = await tap(view, page, 340 * fit * ready.scale, 730 * fit * ready.scale);
    expect(button).toMatch(/^go \d+,\d+$/);
    const [x = 0, y = 0] = button.slice(3).split(",").map(Number);
    expect(Math.abs(x - 340)).toBeLessThanOrEqual(2);
    expect(Math.abs(y - 730)).toBeLessThanOrEqual(2);
};

test(
    "the picture is the page's viewport, sharpened once it settles without the display feeling it, resized and steered from the client",
    async () => {
        const launched = await launch();
        if (launched === undefined) {
            return; // no browser on this box
        }
        const { context, profile } = launched;
        const wire: Wire = { json: [], tags: [], sizes: [], stills: [] };
        const errors: string[] = [];
        const sink = {
            send: (data: string | Uint8Array): void => {
                if (typeof data === "string") {
                    wire.json.push(JSON.parse(data) as object);
                } else {
                    wire.tags.push(data[0] ?? -1);
                    wire.sizes.push(data.byteLength);
                    if (data[0] === FRAME_WEBP) {
                        wire.stills.push(data.slice(1));
                    }
                }
            },
        };
        try {
            const page = context.pages()[0] ?? (await context.newPage());
            // Enough text that a re-render at any other zoom is a frame of motion, not a few hundred bytes.
            const words = Array.from({ length: 60 }, (_, index) => `<p>a page that holds still, line ${index}</p>`).join("");
            await page.goto(`data:text/html,<title>one</title><body style='margin:0;background:%23fff'>${words}</body>`);
            const view = await startLiveView(context, DISPLAY_KEY, sink, (reason) => errors.push(reason));
            try {
                const scale = await expectViewport(wire, page);
                await expectSharpened(wire);
                await settle(() => wire.tags.length > wire.tags.indexOf(FRAME_WEBP) + 30);
                expectStillUnfelt(wire);
                await expectResized(view, wire, page, scale);
                await expectSteered(view, page);
                expect(errors).toEqual([]);
            } finally {
                await view.stop();
            }
        } finally {
            await context.close().catch(() => undefined);
            rmSync(profile, { recursive: true, force: true });
        }
    },
    { timeout: 120_000 },
);

/* Several tabs in one window. Every page Playwright attaches to reports itself visible, so a view that asked the pages
   which was in front always answered the newest: within a second of the owner picking an older tab, the view went back
   to the newest one, photographed it as the still over the picked tab, at its size (x.com over google.com, 2026-10-08).
   The tab in front is read off Chromium's own DevTools list instead (front-tab.ts). */
test(
    "a picked tab stays the picture, and the view still follows a tab switched behind its back or closed",
    async () => {
        const launched = await launch(true);
        if (launched === undefined) {
            return; // no browser on this box
        }
        const { context, profile } = launched;
        const wire: Wire = { json: [], tags: [], sizes: [], stills: [] };
        const sink = {
            send: (data: string | Uint8Array): void => {
                if (data instanceof Uint8Array) {
                    wire.tags.push(data[0] ?? -1);
                    wire.sizes.push(data.byteLength);
                } else {
                    wire.json.push(z.looseObject({}).parse(JSON.parse(data)));
                }
            },
        };
        try {
            const endpoint = await endpointOf(profile);
            const older = context.pages()[0] ?? (await context.newPage());
            await older.goto("data:text/html,<title>older</title><body style='background:%23fdd'>older</body>");
            const newer = await context.newPage();
            await newer.goto("data:text/html,<title>newer</title><body style='background:%23ddf'>newer</body>");
            const view = await startLiveView(context, DISPLAY_KEY, sink, () => undefined, { endpoint });
            try {
                // The newest tab is the one Chromium shows, and so the one the view starts on.
                await settle(() => readies(wire).length > 0 && view.page() === newer);
                expect(view.page()).toBe(newer);
                await view.input({ type: "resize", width: 900, height: 600 });
                await settle(() => readies(wire).some((ready) => ready.width === 900 * ready.scale));
                const sized = readies(wire).length;

                // Picked: it stays picked across the follow loop's next ticks.
                await view.bind(older);
                const shown: (Page | undefined)[] = [];
                for (let tick = 0; tick < 30; tick += 1) {
                    shown.push(view.page());
                    // oxlint-disable-next-line eslint/no-await-in-loop -- sampling the view over three follow ticks
                    await settle(() => false, 100);
                }
                expect(shown.every((page) => page === older)).toBe(true);
                // One window, one size: switching tabs restarts no picture at another size.
                expect(readies(wire).slice(sized).every((ready) => ready.width === 900 * ready.scale && ready.height === 600 * ready.scale)).toBe(true);

                // An agent's own tab switch, which the view hears nothing of, is followed within a tick or two.
                await newer.bringToFront();
                await settle(() => view.page() === newer, 5000);
                expect(view.page()).toBe(newer);

                // The tab in front closing leaves the one Chromium shows next.
                await newer.close();
                await settle(() => view.page() === older, 5000);
                expect(view.page()).toBe(older);
            } finally {
                await view.stop();
            }
        } finally {
            await context.close().catch(() => undefined);
            rmSync(profile, { recursive: true, force: true });
        }
    },
    { timeout: 120_000 },
);

test(
    "a phone on the video path is the device's screen alone, shrunk to fit, aimed through the shrinking, and gone when asked or when the view stops",
    async () => {
        const launched = await launch();
        if (launched === undefined) {
            return; // no browser on this box
        }
        const { context, profile } = launched;
        const wire: Wire = { json: [], tags: [], sizes: [], stills: [] };
        const sink = {
            send: (data: string | Uint8Array): void => {
                if (data instanceof Uint8Array) {
                    wire.tags.push(data[0] ?? -1);
                } else {
                    wire.json.push(z.looseObject({}).parse(JSON.parse(data)));
                }
            },
        };
        try {
            const page = context.pages()[0] ?? (await context.newPage());
            await page.goto(PHONE_PAGE);
            const view = await startLiveView(context, DISPLAY_KEY, sink, () => undefined);
            try {
                await settle(() => readies(wire).length > 0);
                await view.input({ type: "resize", width: 900, height: 600 });
                await settle(() => readies(wire).some((ready) => ready.width === 900 * (ready.scale ?? 1)));
                const desktop = await seen(page);
                expect([desktop.width, desktop.height, desktop.touch]).toEqual([900, 600, 0]);

                // On: the page is the device, and the picture is it whole, shrunk to the 800 px the picture has.
                const before = readies(wire).length;
                await view.input({ type: "emulate", device: PHONE });
                await settle(() => readies(wire).length > before);
                const phone = readies(wire).at(-1);
                if (phone === undefined) {
                    throw new Error("no ready after the phone went on");
                }
                const fit = 800 / 844;
                expect(phone).toMatchObject({ kind: "video", width: Math.round(390 * fit) * phone.scale - ((Math.round(390 * fit) * phone.scale) % 2), height: 800 * phone.scale });
                expect(await seen(page)).toEqual({ width: 390, height: 844, touch: 5, agent: PHONE.userAgent });
                await expectAimed(view, page, phone);

                // The client's box is remembered while the device decides, not obeyed.
                const settled = readies(wire).length;
                await view.input({ type: "resize", width: 1000, height: 700 });
                expect(readies(wire).length).toBe(settled);
                expect((await seen(page)).width).toBe(390);

                // Off: every override gone, and the window is the last box asked for.
                await view.input({ type: "emulate" });
                await settle(() => readies(wire).some((ready, index) => index >= settled && ready.width === 1000 * ready.scale));
                expect(readies(wire).at(-1)).toMatchObject({ width: 1000 * phone.scale, height: 700 * phone.scale });
                const back = await seen(page);
                expect([back.width, back.height, back.touch]).toEqual([1000, 700, 0]);
                expect(back.agent).toBe(desktop.agent);

                // On again, then the socket goes: the agent's next look finds the browser as it was.
                // A second device replaces the first whole, the user agent with it.
                await view.input({ type: "emulate", device: { width: 412, height: 915, mobile: true } });
                expect(await seen(page)).toEqual({ width: 412, height: 915, touch: 5, agent: desktop.agent });
            } finally {
                await view.stop();
            }
            await settle(() => false, 400);
            const after = await seen(page);
            expect(after.width).toBeGreaterThan(400);
            expect(after.touch).toBe(0);
        } finally {
            await context.close().catch(() => undefined);
            rmSync(profile, { recursive: true, force: true });
        }
    },
    { timeout: 120_000 },
);

// A JPEG's size off its first start-of-frame marker.
const jpegSize = (bytes: Uint8Array): PixelSize | undefined => {
    const view = Buffer.from(bytes);
    for (let at = 2; at + 9 < view.length; ) {
        if (view[at] !== 0xff) {
            return undefined;
        }
        const marker = view[at + 1] ?? 0;
        if (marker >= 0xc0 && marker <= 0xc2) {
            return { width: view.readUInt16BE(at + 7), height: view.readUInt16BE(at + 5) };
        }
        at += 2 + view.readUInt16BE(at + 2);
    }
    return undefined;
};

// The frames path: a browser with no display, photographed by its compositor. CDP input is in the picture's pixels
// whatever the scale, and the fixed viewport Playwright set comes back when the phone comes off.
test(
    "a phone on the frames path is announced at its fitted size, aimed in the picture's pixels, and taken off again",
    async () => {
        let playwright: typeof import("playwright");
        try {
            playwright = await import("playwright");
        } catch {
            return; // the package isn't installed
        }
        const executablePath = playwright.chromium.executablePath();
        if (!existsSync(executablePath)) {
            return; // installed, but the binary isn't on disk
        }
        const browser = await playwright.chromium.launch({ headless: true, executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
        try {
            const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
            const page = await context.newPage();
            await page.goto(PHONE_PAGE);
            const wire: Wire = { json: [], tags: [], sizes: [], stills: [] };
            // Each motion frame's size, in the order they came.
            const frames: (PixelSize | undefined)[] = [];
            const sink = {
                send: (data: string | Uint8Array): void => {
                    if (!(data instanceof Uint8Array)) {
                        wire.json.push(z.looseObject({}).parse(JSON.parse(data)));
                    } else if (data[0] === FRAME_JPEG) {
                        frames.push(jpegSize(data.slice(1)));
                    }
                },
            };
            const view = await startLiveView(context, "no-display-here", sink, () => undefined);
            try {
                expect(readies(wire)).toEqual([{ type: "ready", kind: "frames", width: 1280, height: 800, scale: 1 }]);
                const before = frames.length;
                await view.input({ type: "emulate", device: PHONE });
                expect(readies(wire).at(-1)).toEqual({ type: "ready", kind: "frames", width: 370, height: 800, scale: 1 });
                // The frames are the device's screen and nothing else, at the size the `ready` gave.
                await settle(() => frames.slice(before).some((size) => size?.width === 370));
                expect(frames.slice(before).at(-1)).toEqual({ width: 370, height: 800 });
                expect(await seen(page)).toEqual({ width: 390, height: 844, touch: 5, agent: PHONE.userAgent });
                const phone = readies(wire).at(-1);
                if (phone === undefined) {
                    throw new Error("no ready after the phone went on");
                }
                await expectAimed(view, page, phone);
                // Anything but an emulate of the right shape is dropped.
                // As the route reads it: parsed off the socket and handed on unchecked.
                const malformed: Parameters<LiveView["input"]>[0] = JSON.parse(`{"type":"emulate","device":{"width":"wide","height":10,"mobile":true}}`);
                await view.input(malformed);
                expect((await seen(page)).width).toBe(390);
                await view.input({ type: "emulate" });
                expect(readies(wire).at(-1)).toEqual({ type: "ready", kind: "frames", width: 1280, height: 800, scale: 1 });
                expect(await seen(page)).toMatchObject({ width: 1280, height: 800, touch: 0 });
                await view.input({ type: "emulate", device: PHONE });
            } finally {
                await view.stop();
            }
            expect(await seen(page)).toMatchObject({ width: 1280, height: 800, touch: 0 });
        } finally {
            await browser.close().catch(() => undefined);
        }
    },
    { timeout: 120_000 },
);
