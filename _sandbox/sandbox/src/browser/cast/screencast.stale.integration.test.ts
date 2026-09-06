import { existsSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { expect, test } from "vitest";
import { ensureDisplay } from "./display.js";
import { startScreencast, VIEW_HEIGHT, VIEW_WIDTH, type ScreencastFrame } from "./screencast.js";

/* THE CLICK THAT LOOKED LIKE IT DID NOTHING.
 *
 * Taking the sharp still re-rasters the page, so the frames that arrive just after one are usually the camera's
 * own shake and are dropped: see CAPTURE_ECHO_MS. The trouble is that this window is also precisely where the
 * page's answer to a click lands, because the click is what ended the quiet that armed the capture. Dropping it
 * and scheduling nothing left the viewer looking at the screen they had already left: the button they pressed
 * still sitting there, the page long since moved on, and no frame ever coming to say so.
 *
 * The scenario is staged rather than raced: settle the view, take a capture, and click while the echo window is
 * still open. Real Chromium, because the whole question is what Chromium does to the page when it is
 * photographed: a fake session would happily prove we suppressed the frames we meant to suppress. */

/* HEADED, ON THE VIRTUAL DISPLAY, which is not a detail here, it is the whole experiment.
 *
 * Both surfaces run Chromium headed against Xvfb, because a headless shell is fingerprinted and turned away by
 * the sign-in pages people are taken to these windows to rescue. Headless is also where photographing the page
 * barely disturbs it: the re-raster this test is about is far quieter there, so the same code that strands a
 * real viewer forever sails through a headless version of this file. A first draft of this test did exactly
 * that: passed, identically, against the broken code it was written to pin. */
const launch = async (): Promise<Browser | undefined> => {
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
    // A display of this test's own, which is what ensureDisplay's key buys: the suite may run beside a daemon
    // that has browsers of its own on theirs, and two Chromiums on one display would overlap.
    const display = await ensureDisplay("screencast-stale-test").catch(() => undefined);
    if (display === undefined) {
        return undefined; // no virtual display on this box, so no headed browser to ask
    }
    return playwright.chromium
        .launch({ executablePath, headless: false, env: { ...process.env, DISPLAY: display.name }, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
        .catch(() => undefined);
};

/* A minute, for the reason spelled out over the same helper in screencast.integration.test.ts: the 2x screenshot
 * every sharp frame is made of was measured taking 5.5 seconds while the rest of `pnpm test` had the cores, and
 * a ten-second budget stops looking while the picture is still being taken. */
const settle = async (until: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 6000 && !until(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

// Two full-bleed screens, one hidden. Which one the viewer is being shown is then a single pixel: the second
// screen is black where the first is white, so a decoded frame answers "has the click been shown yet?".
const TWO_SCREENS = `<body style="margin:0;background:#fff">
    <button id="go" style="position:absolute;left:500px;top:380px;width:260px;height:60px">Continue</button>
    <div id="second" style="display:none;position:fixed;inset:0;background:#000"></div>
    <script>document.getElementById('go').addEventListener('click', () => {
        document.getElementById('second').style.display = 'block';
    });</script>
</body>`;

/* What the viewer's newest frame is a picture OF, as one number: black (the second screen) or white (the first).
 *
 * The page doing the decoding lives in a DIFFERENT context, and that is load-bearing rather than tidy. A
 * screencast follows the newest page in its own context and rebinds when one closes, so a reader opened next
 * to the page under test moves the stream onto itself and then, on closing, rebinds and clears the suppression
 * state on the way back. Checking the picture that way REPAIRS the freeze being checked for: the second draft
 * of this test passed against the broken code for that reason alone, having measured its own side effect. */
const centreOf = async (reader: Page, frame: ScreencastFrame): Promise<number> =>
    reader.evaluate(async (dataUrl: string) => {
        const image = new Image();
        image.src = dataUrl;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.width;
        canvas.height = image.height;
        const ctx = canvas.getContext("2d")!;
        ctx.drawImage(image, 0, 0);
        return ctx.getImageData(image.width / 2, image.height / 2, 1, 1).data[0]!;
        // Frames travel as bytes now; a data URL is only how this test hands one to a page that can decode it.
    }, `data:image/${frame.format};base64,${frame.bytes.toString("base64")}`);

/* Swept rather than staged at one offset. The suppression window is a few hundred milliseconds wide and moves
 * with the debounce, so a single hand-picked delay proves only that one delay: it is exactly how the first
 * attempt at this fix passed its own test while leaving the hole a click could still fall into. Each offset
 * lands the press somewhere different relative to the capture: before it, inside it, inside the echo behind
 * it, and every one of them has to end with the viewer looking at the screen the page is actually on. */
test.each([0, 120, 260, 420, 560, 700])("a click %ims after the page settles still reaches the viewer", { timeout: 120_000 }, async (offset) => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(TWO_SCREENS)}`);
        // Somewhere to decode frames that the screencast will never follow: see centreOf.
        const reader = await (await browser.newContext()).newPage();

        const frames: ScreencastFrame[] = [];
        // Timed from the sharp frame itself, not from when this test got round to noticing it. The window
        // being probed is a couple of hundred milliseconds wide, and decoding a picture to check it costs
        // about that much: an earlier draft did its "before" assertion first and pushed every offset
        // clean past the window it was aiming at, which is why every one of them passed against the bug.
        let sharpAt = 0;
        const screencast = await startScreencast(context, (frame) => {
            frames.push(frame);
            if (frame.format === "webp" && sharpAt === 0) {
                sharpAt = Date.now();
            }
        });
        try {
            // Reach the state the bug needs: settled, sharp, and photographing itself on a timer.
            await settle(() => sharpAt !== 0);
            await new Promise((resolve) => setTimeout(resolve, Math.max(0, sharpAt + offset - Date.now())));
            await page.mouse.click(630, 410);
            expect(await page.evaluate(() => getComputedStyle(document.getElementById("second")!).display)).toBe("block");

            /* Converge, don't race: a press landing outside any window is forwarded at once, one landing
             * inside waits for the next capture to notice. Both are correct; being wrong FOREVER is not,
             * and that is what a bounded wait for the right picture distinguishes. The bound is generous for
             * the same measured reason as the settle above: the capture that has to notice takes seconds, not
             * milliseconds, on a box running the whole monorepo's suites. */
            let centre = 255;
            for (let attempt = 0; attempt < 400 && centre > 64; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 100));
                centre = await centreOf(reader, frames.at(-1)!);
            }
            expect(centre).toBeLessThan(64);
        } finally {
            await screencast.stop();
        }
    } finally {
        await browser.close();
    }
});
