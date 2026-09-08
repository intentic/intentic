import { existsSync } from "node:fs";
import type { Browser, Page } from "playwright";
import { expect, test } from "vitest";
import { ensureDisplay } from "./display.js";
import { startScreencast, VIEW_HEIGHT, VIEW_WIDTH, type ScreencastFrame } from "./screencast.js";

// Taking the still re-rasters the page, dropping frames right after as camera shake, exactly when a click lands,
// stranding the viewer. Staged, not raced, against real Chromium: what Chromium does when photographed.

// Headed against Xvfb, not headless: headless barely disturbs the page when photographed, which would hide the
// re-raster this test exists to catch.
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
    // Own display via ensureDisplay's key, since sharing one with a daemon's browsers would overlap.
    const display = await ensureDisplay("screencast-stale-test").catch(() => undefined);
    if (display === undefined) {
        return undefined; // no virtual display on this box, so no headed browser to ask
    }
    return playwright.chromium
        .launch({ executablePath, headless: false, env: { ...process.env, DISPLAY: display.name }, args: ["--no-sandbox", "--disable-dev-shm-usage"] })
        .catch(() => undefined);
};

// A full minute, same reason as screencast.integration.test.ts's settle: the capture can take much longer than a naive
// timeout would allow under load.
const settle = async (until: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 6000 && !until(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
};

// Two full-bleed screens, black vs white, so one decoded pixel answers whether the click has been shown.
const TWO_SCREENS = `<body style="margin:0;background:#fff">
    <button id="go" style="position:absolute;left:500px;top:380px;width:260px;height:60px">Continue</button>
    <div id="second" style="display:none;position:fixed;inset:0;background:#000"></div>
    <script>document.getElementById('go').addEventListener('click', () => {
        document.getElementById('second').style.display = 'block';
    });</script>
</body>`;

// Reads the frame's centre pixel as a number. The reader must live in a separate context: a screencast follows the
// newest page and rebinds on close, so a same-context reader would move the stream and mask the freeze being tested.
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
        // Frames travel as bytes; a data URL is only how this test hands one to a page that can decode it.
    }, `data:image/${frame.format};base64,${frame.bytes.toString("base64")}`);

// Swept across offsets rather than staged at one, since the window moves with the debounce and one delay only proves
// itself. Each offset lands the click before, inside, or behind the capture; all must still reach the viewer.
test.each([0, 120, 260, 420, 560, 700])("a click %ims after the page settles still reaches the viewer", { timeout: 120_000 }, async (offset) => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(TWO_SCREENS)}`);
        // Separate page to decode frames, one the screencast will never follow.
        const reader = await (await browser.newContext()).newPage();

        const frames: ScreencastFrame[] = [];
        // Timed from the sharp frame itself, not from when the test notices it: the window is only hundreds of ms wide.
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

            // Converges rather than races: a press outside any window forwards at once, one inside waits.
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
