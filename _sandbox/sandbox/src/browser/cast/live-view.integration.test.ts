import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserContext, Page } from "playwright";
import { test, expect, afterAll } from "bun:test";
import { chromiumWindowArgs, DISPLAY_HEIGHT, DISPLAY_WIDTH, ensureDisplay, releaseDisplay } from "./display.js";
import { startLiveView, type LiveReady, type LiveView } from "./live-view.js";
import { readRegion } from "./region.js";
import { FRAME_WEBP } from "./screencast.js";
import { FRAME_H264_DELTA_QUIET, FRAME_H264_KEY, FRAME_H264_KEY_QUIET } from "./videocast.js";

// The video path end to end on a real display: Chromium headed on Xvfb, ffmpeg grabbing it, the daemon's own view
// over a fake socket. Skips where the browser pack is not installed. What it pins is what no unit can: that the
// region read off the page is the picture's size, that a still follows a settled page and the frames after it are
// quiet, and that a resize and a navigation from the client's chrome land.

const DISPLAY_KEY = "live-view-test";
const SCREEN = { width: DISPLAY_WIDTH, height: DISPLAY_HEIGHT };

interface Wire {
    readonly json: object[];
    readonly tags: number[];
}

const launch = async (): Promise<{ context: BrowserContext; profile: string } | undefined> => {
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
            args: ["--no-sandbox", "--disable-dev-shm-usage", ...chromiumWindowArgs(display)],
        })
        .catch(() => undefined);
    if (context === undefined) {
        rmSync(profile, { recursive: true, force: true });
        return undefined;
    }
    return { context, profile };
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

test(
    "the picture is the page's viewport, sharpened once it settles, resized and steered from the client",
    async () => {
        const launched = await launch();
        if (launched === undefined) {
            return; // no browser on this box
        }
        const { context, profile } = launched;
        const wire: Wire = { json: [], tags: [] };
        const errors: string[] = [];
        const sink = {
            send: (data: string | Uint8Array): void => {
                if (typeof data === "string") {
                    wire.json.push(JSON.parse(data) as object);
                } else {
                    wire.tags.push(data[0] ?? -1);
                }
            },
        };
        try {
            const page = context.pages()[0] ?? (await context.newPage());
            await page.goto("data:text/html,<title>one</title><body style='margin:0;background:%23fff'><p>a page that holds still</p></body>");
            const view = await startLiveView(context, DISPLAY_KEY, sink, (reason) => errors.push(reason));
            try {
                const scale = await expectViewport(wire, page);
                await expectSharpened(wire);
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
