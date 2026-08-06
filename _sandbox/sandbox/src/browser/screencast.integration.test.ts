import { expect, test } from "vitest";
import { dispatchInput, startScreencast, VIEW_HEIGHT, VIEW_WIDTH, type ScreencastFrame } from "./screencast.js";

/* THE STILL HAS TO PHOTOGRAPH WHAT IS ON SCREEN. Everything the screencast does is arranged around one high
 * resolution capture 400ms after the page settles, and that capture takes a CLIP — which CDP measures from the
 * top of the DOCUMENT, not from the top of the viewport. A clip that names a region the compositor isn't
 * holding comes back BLANK rather than as an error, so the failure mode this pins is not a crash: it is a white
 * rectangle dropped over the live picture every time a person stops scrolling, which is what "the view
 * flickers" turned out to mean.
 *
 * Real Chromium, because the bug lives entirely in what Chromium does with the arguments — a fake CDP session
 * would happily assert we passed the right numbers to something that never had this behaviour. The still is
 * read back by DECODING it in a second page of the same browser and sampling pixels, which is the only check
 * that distinguishes "sharp picture of the right place" from "a blank of exactly the right size". */

// A page of 100px bands whose red channel is its index, so one pixel answers "which part of the page is this?".
const BANDS = 60;
const BAND_HEIGHT = 100;
const SCROLL_TO = 2000;
const bandPage = `<body style="margin:0">${Array.from(
    { length: BANDS },
    (_, index) => `<div style="height:${BAND_HEIGHT}px;background:rgb(${index * 4},0,60)">band ${index}</div>`,
).join("")}</body>`;

test("the settle still photographs the page where it is now, not the top of the document", { timeout: 120_000 }, async () => {
    let playwright: typeof import("playwright");
    try {
        playwright = await import("playwright");
    } catch {
        return; // no Chromium on disk — nothing to photograph
    }
    const browser = await playwright.chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] }).catch(() => undefined);
    if (browser === undefined) {
        return; // the package is installed but the binary isn't
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(bandPage)}`);
        await page.evaluate((offset) => window.scrollTo(0, offset), SCROLL_TO);

        const stills: ScreencastFrame[] = [];
        const screencast = await startScreencast(context, (frame) => {
            if (frame.format === "webp") {
                stills.push(frame);
            }
        });
        try {
            // The still is debounced off the last motion frame, and capturing one makes the page repaint — so
            // wait for one to ARRIVE rather than sleeping past a guess at that cycle (browser-sessions' rule).
            for (let attempt = 0; attempt < 200 && stills.length === 0; attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            expect(stills.length).toBeGreaterThan(0);

            // Decode the still and read the band at its top edge and its bottom edge. A blank capture answers
            // 255 for both (white), and a capture of the document's top answers band 0 — neither is band 20.
            const reader = await context.newPage();
            const bands = await reader.evaluate(
                async (dataUrl) => {
                    const image = new Image();
                    image.src = dataUrl;
                    await image.decode();
                    const canvas = document.createElement("canvas");
                    canvas.width = image.width;
                    canvas.height = image.height;
                    const ctx = canvas.getContext("2d")!;
                    ctx.drawImage(image, 0, 0);
                    const bandAt = (y: number): number => Math.round(ctx.getImageData(image.width / 2, y, 1, 1).data[0]! / 4);
                    return { top: bandAt(2), bottom: bandAt(image.height - 2), width: image.width, height: image.height };
                },
                `data:image/webp;base64,${stills.at(-1)!.data}`,
            );

            expect(bands.top).toBe(SCROLL_TO / BAND_HEIGHT);
            expect(bands.bottom).toBe((SCROLL_TO + VIEW_HEIGHT) / BAND_HEIGHT - 1);
            // And it is the HIGH-resolution one: the still exists to be sharper than the motion stream.
            expect(bands.width).toBeGreaterThan(VIEW_WIDTH);
        } finally {
            await screencast.stop();
        }
    } finally {
        await browser.close();
    }
});

/* A PAGE THAT IS DOING NOTHING SHOULD SEND NOTHING. The still is worth taking because most of watching a
 * browser is watching something hold still — but taking it re-rasters the page, and the screencast encoded that
 * wobble as motion frames which replaced the sharp picture and re-armed the debounce that took it. The stream
 * then fed itself: sharp, blurry, sharp, blurry, at ~2Hz, on a page where literally nothing was happening, for
 * as long as the view stayed open. It flickered, and it billed a tunnel round trip for the privilege.
 *
 * The assertion is a COUNT over an interval rather than a look at any one frame, because the bug was never in a
 * frame — every one of them was a fine picture of the right page. It was in there being an endless supply. */
test("a page where nothing is happening settles into silence", { timeout: 120_000 }, async () => {
    let playwright: typeof import("playwright");
    try {
        playwright = await import("playwright");
    } catch {
        return; // no Chromium on disk
    }
    const browser = await playwright.chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] }).catch(() => undefined);
    if (browser === undefined) {
        return;
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent("<body style='margin:0'><h1>nothing is happening here</h1></body>")}`);

        const frames: ScreencastFrame[] = [];
        const screencast = await startScreencast(context, (frame) => frames.push(frame));
        try {
            // Well past the settle: three seconds is five of the cycles the old stream sustained.
            await new Promise((resolve) => setTimeout(resolve, 3000));
            // What a static page is worth: the picture, and one sharp reading of it.
            expect(frames.filter((frame) => frame.format === "webp")).toHaveLength(1);
            expect(frames.length).toBeLessThanOrEqual(4);
            // And the last word is the sharp one — a blurry echo arriving after it is the flicker itself.
            expect(frames.at(-1)?.format).toBe("webp");
        } finally {
            await screencast.stop();
        }
    } finally {
        await browser.close();
    }
});

/* WHERE A PASTE ENDS UP. The user's clipboard cannot reach the Chromium in the sandbox, so both surfaces turn
 * Ctrl/Cmd+V into a `text` frame and this is the far end of that: a password arriving whole in the field the
 * person clicked, in one insert rather than as a string of synthetic keystrokes. Worth a real page because the
 * question is whether the FOCUSED element receives it, which is a fact about Chromium rather than about our JSON. */
test("a text frame lands in whatever field the page has focused", { timeout: 120_000 }, async () => {
    let playwright: typeof import("playwright");
    try {
        playwright = await import("playwright");
    } catch {
        return; // no Chromium on disk
    }
    const browser = await playwright.chromium.launch({ args: ["--no-sandbox", "--disable-dev-shm-usage"] }).catch(() => undefined);
    if (browser === undefined) {
        return;
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(`<input id="password" type="password" autofocus>`)}`);
        const session = await context.newCDPSession(page);

        const pasted = "correct horse battery staple";
        await dispatchInput(session, { type: "text", text: pasted });
        expect(await page.inputValue("#password")).toBe(pasted);

        // And it composes with typing, so a pasted password can still be finished by hand.
        await dispatchInput(session, { type: "text", text: "!" });
        expect(await page.inputValue("#password")).toBe(`${pasted}!`);
    } finally {
        await browser.close();
    }
});
