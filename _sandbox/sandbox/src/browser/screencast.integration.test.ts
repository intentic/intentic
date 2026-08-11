import { existsSync } from "node:fs";
import type { Browser } from "playwright";
import { expect, test } from "vitest";
import { dispatchInput, readSelection, startScreencast, VIEW_HEIGHT, VIEW_WIDTH, type ScreencastFrame } from "./screencast.js";

/* THE CHROMIUM ON DISK IS THE HEADED ONE. The image installs the browser the agent's tools and the profile
 * windows need, and `chromium.launch()` on its own reaches instead for a headless-SHELL build that was never
 * downloaded — so every test in this file used to skip itself, silently, on a machine that had a perfectly good
 * browser sitting right there. Naming the executable is the same thing browser-tools.ts tells @playwright/mcp
 * to do, for the same reason. Absent for real, they still skip: a box with no browser can't answer these. */
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
    return playwright.chromium.launch({ executablePath, args: ["--no-sandbox", "--disable-dev-shm-usage"] }).catch(() => undefined);
};

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

/* Wait for something Chromium does on its own timetable rather than sleeping a guess past it — the same rule,
 * and the same reason, as browser-sessions.integration.test.ts. The still is DEBOUNCED off the last motion
 * frame and taking it re-rasters the page, so the first webp lands ~600ms in on an idle box and far later when
 * the whole monorepo's suites are on the same cores. Generous and finite, so a real regression still fails on
 * the assertion that follows instead of hanging to the test timeout. */
const settle = async (until: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 200 && !until(); attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

// A page of 100px bands whose red channel is its index, so one pixel answers "which part of the page is this?".
const BANDS = 60;
const BAND_HEIGHT = 100;
const SCROLL_TO = 2000;
const bandPage = `<body style="margin:0">${Array.from(
    { length: BANDS },
    (_, index) => `<div style="height:${BAND_HEIGHT}px;background:rgb(${index * 4},0,60)">band ${index}</div>`,
).join("")}</body>`;

test("the settle still photographs the page where it is now, not the top of the document", { timeout: 120_000 }, async () => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
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
            // wait for one to ARRIVE rather than sleeping past a guess at that cycle.
            await settle(() => stills.length > 0);
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
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent("<body style='margin:0'><h1>nothing is happening here</h1></body>")}`);

        const frames: ScreencastFrame[] = [];
        const screencast = await startScreencast(context, (frame) => frames.push(frame));
        try {
            // Silence is measured FROM the still, not from here. One fixed span covering both the capture and
            // the quiet after it is the stopwatch this suite keeps losing to: on a loaded machine the sharp
            // frame simply hadn't been taken yet, and "no still" read as "no silence".
            await settle(() => frames.some((frame) => frame.format === "webp"));
            // Then watch: three seconds is five of the cycles the old self-sustaining stream ran at.
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
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
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

/* A CHORD HAS TO ARRIVE AS AN EDITING COMMAND, not as a keystroke the page shrugs off.
 *
 * Ctrl+A used to be unsendable — the wire carried no modifiers and the key table held no letters — so it fell
 * through to the app AROUND the picture, where it selected the whole of Intentic instead of the field the
 * person was looking at. What makes the fix work is not the flag but the SHAPE of the event: Chromium's
 * renderer derives select-all, cut, undo and the rest from a raw key event's code and virtual key code, and
 * quietly does nothing at all if the chord arrives carrying text. Only real Chromium can tell those apart,
 * which is why this is an integration test and not an assertion about the JSON we emitted. */
test("editing chords land as editing commands in the page", { timeout: 120_000 }, async () => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(`<input id="a" value="hello world" autofocus><input id="b">`)}`);
        const session = await context.newCDPSession(page);
        const selection = async (): Promise<{ start: number | null; end: number | null }> =>
            page.evaluate(() => {
                const field = document.querySelector<HTMLInputElement>("#a")!;
                return { start: field.selectionStart, end: field.selectionEnd };
            });

        // Select all — the one that sent the user here.
        await dispatchInput(session, { type: "key", key: "a", ctrl: true });
        expect(await selection()).toEqual({ start: 0, end: "hello world".length });

        // Cut empties the field, and what it took is really on that browser's clipboard: pasting it into the
        // second field is the proof, and the round trip a person expects of a cut.
        await dispatchInput(session, { type: "key", key: "x", ctrl: true });
        expect(await page.inputValue("#a")).toBe("");
        await page.focus("#b");
        await dispatchInput(session, { type: "key", key: "v", ctrl: true });
        expect(await page.inputValue("#b")).toBe("hello world");

        // Undo, against text typed the way this wire types it.
        await page.focus("#a");
        await dispatchInput(session, { type: "text", text: "typed by hand" });
        await dispatchInput(session, { type: "key", key: "z", ctrl: true });
        expect(await page.inputValue("#a")).not.toBe("typed by hand");

        /* SHIFT IS A MODIFIER TOO, and its absence was the quieter half of the same bug: the arrow keys were
         * already forwarded, so Shift+ArrowLeft reached the page — stripped of the Shift, where it moved the
         * caret instead of extending a selection. Silently doing the wrong thing rather than nothing. */
        await page.fill("#a", "hello world");
        await dispatchInput(session, { type: "key", key: "End" });
        for (let press = 0; press < "world".length; press += 1) {
            await dispatchInput(session, { type: "key", key: "ArrowLeft", shift: true });
        }
        expect(await selection()).toEqual({ start: "hello ".length, end: "hello world".length });
    } finally {
        await browser.close();
    }
});

/* THE SELECTION HAS TO COME BACK OUT, because the clipboard it was copied to is the sandbox's and the person
 * is not sitting in the sandbox. Both places it can hide are pinned here: a focused field, whose selection
 * window.getSelection() cannot see, and an embedded frame — which is not an exotic case but the ordinary one,
 * since what people copy out of these windows is usually inside a sign-in the site embedded. */
test("the selection is read back out of a field, and out of an embedded frame", { timeout: 120_000 }, async () => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(`<input id="code" value="one-time 314159" autofocus><p>page prose</p>`)}`);
        const session = await context.newCDPSession(page);

        // Nothing selected yet, and an empty answer is an answer — the client must not put stale text on a
        // clipboard because a keystroke found no selection.
        expect(await readSelection(page)).toBe("");

        await dispatchInput(session, { type: "key", key: "a", ctrl: true });
        expect(await readSelection(page)).toBe("one-time 314159");

        // The same page's own prose, selected outside any field: the other half of the read.
        await page.evaluate(() => {
            document.querySelector<HTMLInputElement>("#code")!.blur();
            const range = document.createRange();
            range.selectNodeContents(document.querySelector("p")!);
            const selected = window.getSelection()!;
            selected.removeAllRanges();
            selected.addRange(range);
        });
        expect(await readSelection(page)).toBe("page prose");

        // And inside an embedded frame, where the top document has nothing to report.
        const embedded = await context.newPage();
        await embedded.goto(`data:text/html,${encodeURIComponent(`<iframe srcdoc="<p id='inner'>signed in as someone@example.com</p>"></iframe>`)}`);
        const inner = await embedded.waitForSelector("iframe").then((handle) => handle.contentFrame());
        await inner!.evaluate(() => {
            const range = document.createRange();
            range.selectNodeContents(document.querySelector("#inner")!);
            const selected = window.getSelection()!;
            selected.removeAllRanges();
            selected.addRange(range);
        });
        expect(await readSelection(embedded)).toBe("signed in as someone@example.com");
    } finally {
        await browser.close();
    }
});
