import { existsSync } from "node:fs";
import type { Browser, CDPSession } from "playwright";
import { expect, test } from "vitest";
import {
    applySelect,
    dispatchInput,
    readSelect,
    readSelection,
    startScreencast,
    VIEW_HEIGHT,
    VIEW_WIDTH,
    type ScreencastFrame,
} from "./screencast.js";

// Launches the headed Chromium the image actually installs (`chromium.launch()` alone reaches for an undownloaded
// headless-shell build); skips if no browser exists at all.
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

// CDP's clip is measured from the document's top, not the viewport's; a clip outside what the compositor holds comes
// back blank, not an error. Real Chromium only, verified by decoding the still and sampling pixels.

// Polls for a condition rather than sleeping a guess, since the still lands on Chromium's own schedule and load can
// push that far out; generous (a full minute) but finite, so a regression still fails the assertion instead of hanging.
const settle = async (until: () => boolean): Promise<void> => {
    for (let attempt = 0; attempt < 1200 && !until(); attempt += 1) {
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
        // Scroll must be confirmed, not just requested: a data: URL's bands may still be arriving, clamping it short.
        await page.waitForFunction((offset) => {
            window.scrollTo(0, offset);
            return window.scrollY === offset;
        }, SCROLL_TO);

        const stills: ScreencastFrame[] = [];
        const screencast = await startScreencast(context, (frame) => {
            if (frame.format === "webp") {
                stills.push(frame);
            }
        });
        try {
            await settle(() => stills.length > 0);
            expect(stills.length).toBeGreaterThan(0);

            // Blank capture reads 255 (white) at both edges; the document's top reads band 0; neither is the expected
            // band.
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
                // Frames travel as bytes; a data URL is only how this hands one to a page that can decode it.
                `data:image/webp;base64,${stills.at(-1)!.bytes.toString("base64")}`,
            );

            expect(bands.top).toBe(SCROLL_TO / BAND_HEIGHT);
            expect(bands.bottom).toBe((SCROLL_TO + VIEW_HEIGHT) / BAND_HEIGHT - 1);
            // It's the high-resolution capture: the still exists to be sharper than the motion stream.
            expect(bands.width).toBeGreaterThan(VIEW_WIDTH);
        } finally {
            await screencast.stop();
        }
    } finally {
        await browser.close();
    }
});

// Taking the still re-rasters the page, feeding back as motion that re-arms the debounce, a loop on a static page.
// Counts frames over an interval, not any one, since each frame alone looks fine.
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
            // Waits for the still first, then measures silence from there, not from here, or a slow still reads as
            // silence.
            await settle(() => frames.some((frame) => frame.format === "webp"));
            // Watches for three seconds, comfortably longer than one capture-repaint cycle.
            await new Promise((resolve) => setTimeout(resolve, 3000));
            // Up to a few frames may arrive before the still settles; only one may be sharp.
            expect(frames.filter((frame) => frame.format === "webp")).toHaveLength(1);
            expect(frames.length).toBeLessThanOrEqual(4);
            // The last frame must be the sharp one; a blurry frame arriving after it would be the flicker recurring.
            expect(frames.at(-1)?.format).toBe("webp");
        } finally {
            await screencast.stop();
        }
    } finally {
        await browser.close();
    }
});

// `Page.stopScreencast` is a request, not a barrier: an in-flight frame can land after the stop. Delivered by hand,
// since a test can't schedule a real late arrival; what's pinned is that it's dropped, not forwarded.
const deliverLateFrame = (session: CDPSession | undefined): void => {
    (session as unknown as { readonly emit: (event: string, payload: unknown) => boolean } | undefined)?.emit("Page.screencastFrame", {
        data: "late",
        sessionId: 1,
        metadata: {},
    });
};

test("a paused view stays silent even when a frame arrives after the stop", { timeout: 120_000 }, async () => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent("<body style='margin:0'><h1>watch this</h1></body>")}`);

        const frames: ScreencastFrame[] = [];
        const screencast = await startScreencast(context, (frame) => frames.push(frame));
        try {
            // Pause from a settled stream, so nothing below can be blamed on the view still starting up.
            await settle(() => frames.some((frame) => frame.format === "webp"));
            await screencast.setPaused(true);
            frames.length = 0;

            // Page really moves while paused; that's the frame Chromium was holding when the stop arrived, delivered
            // late.
            await page.evaluate(() => {
                document.body.style.background = "rebeccapurple";
            });
            deliverLateFrame(screencast.attached());
            await new Promise((resolve) => setTimeout(resolve, 1000));
            expect(frames).toHaveLength(0);

            // Binding survives the pause: coming back is one frame away, not a reconnect.
            await screencast.setPaused(false);
            await settle(() => frames.length > 0);
            expect(frames.length).toBeGreaterThan(0);
        } finally {
            await screencast.stop();
        }
    } finally {
        await browser.close();
    }
});

// Fields are focused by hand, not via `autofocus`, which only applies once the window gains focus, on Chromium's own
// timetable, after `goto` resolves. Each test pins what the focused element does with the frame.

// Client's Ctrl/Cmd+V becomes a `text` frame, since its clipboard can't reach the Chromium; it arrives as one insert,
// not synthetic keystrokes. Real Chromium, since the question is what the focused element does.
test("a text frame lands in whatever field the page has focused", { timeout: 120_000 }, async () => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(`<input id="password" type="password">`)}`);
        await page.focus("#password");
        const session = await context.newCDPSession(page);

        const pasted = "correct horse battery staple";
        await dispatchInput(session, { type: "text", text: pasted });
        expect(await page.inputValue("#password")).toBe(pasted);

        // Composes with typing: a pasted password can still be finished by hand.
        await dispatchInput(session, { type: "text", text: "!" });
        expect(await page.inputValue("#password")).toBe(`${pasted}!`);
    } finally {
        await browser.close();
    }
});

// A chord must arrive as a raw key event, not text, since Chromium derives select-all/cut/undo from that shape and
// ignores one that looks typed. Real Chromium only, since it alone can tell those apart.
test("editing chords land as editing commands in the page", { timeout: 120_000 }, async () => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(`<input id="a" value="hello world"><input id="b">`)}`);
        await page.focus("#a");
        const session = await context.newCDPSession(page);
        const selection = async (): Promise<{ start: number | null; end: number | null }> =>
            page.evaluate(() => {
                const field = document.querySelector<HTMLInputElement>("#a")!;
                return { start: field.selectionStart, end: field.selectionEnd };
            });

        await dispatchInput(session, { type: "key", key: "a", ctrl: true });
        expect(await selection()).toEqual({ start: 0, end: "hello world".length });

        // Cut really populates the clipboard; pasting into the second field is the proof, the round trip expected.
        await dispatchInput(session, { type: "key", key: "x", ctrl: true });
        expect(await page.inputValue("#a")).toBe("");
        await page.focus("#b");
        await dispatchInput(session, { type: "key", key: "v", ctrl: true });
        expect(await page.inputValue("#b")).toBe("hello world");

        // Undo against text typed through this same wire.
        await page.focus("#a");
        await dispatchInput(session, { type: "text", text: "typed by hand" });
        await dispatchInput(session, { type: "key", key: "z", ctrl: true });
        expect(await page.inputValue("#a")).not.toBe("typed by hand");

        // Shift+ArrowLeft must extend the selection, not just move the caret with the Shift silently dropped.
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

// An open <select> is a native menu the browser draws, not the compositor surface, so no frame shows it. Pinned against
// real Chromium: options read from whatever has focus, even in an embedded form, and a pick fires a real change.
test("a focused drop-down can be read out and picked from", { timeout: 120_000 }, async () => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(
            `data:text/html,${encodeURIComponent(
                `<body style="margin:0">
                    <select id="month" style="position:absolute;left:100px;top:60px;width:200px;height:40px">
                        <option>January</option><option>February</option><option disabled>March</option><option>April</option>
                    </select>
                    <p id="chosen">nothing yet</p>
                    <script>document.getElementById('month').addEventListener('change', (e) => {
                        document.getElementById('chosen').textContent = e.target.value;
                    });</script>
                </body>`,
            )}`,
        );

        // No focus means no menu; this is also what closes one the owner clicked away from.
        expect(await readSelect(page)).toBeUndefined();

        await page.focus("#month");
        const menu = await readSelect(page);
        expect(menu?.options.map((option) => option.label)).toEqual(["January", "February", "March", "April"]);
        expect(menu?.selected).toBe(0);
        // A disabled row has to arrive marked, or the menu would offer a choice the page will refuse.
        expect(menu?.options[2]?.disabled).toBe(true);
        // Placed where the control actually is, so the menu opens over it, not near it.
        expect(menu?.rect.x).toBeCloseTo(100, 0);
        expect(menu?.rect.y).toBeCloseTo(60, 0);

        // The pick has to be a real one: the page's own change handler is what proves it, not the value alone.
        await applySelect(page, 3);
        expect(await page.inputValue("#month")).toBe("April");
        expect(await page.textContent("#chosen")).toBe("April");

        // Sign-in fields usually sit inside an iframe; a top read finds nothing, so the rect is offset accordingly.
        const embedded = await context.newPage();
        await embedded.goto(
            `data:text/html,${encodeURIComponent(
                `<body style="margin:0"><iframe style="position:absolute;left:50px;top:30px;width:400px;height:200px;border:0"
                    srcdoc="<select id='y' style='position:absolute;left:10px;top:20px'><option>2001</option><option>2002</option></select>"></iframe></body>`,
            )}`,
        );
        const inner = await embedded.waitForSelector("iframe").then((handle) => handle.contentFrame());
        await inner!.focus("#y");
        const nested = await readSelect(embedded);
        expect(nested?.options.map((option) => option.label)).toEqual(["2001", "2002"]);
        expect(nested?.rect.x).toBeCloseTo(60, 0);
        expect(nested?.rect.y).toBeCloseTo(50, 0);

        await applySelect(embedded, 1);
        expect(await inner!.inputValue("#y")).toBe("2002");
    } finally {
        await browser.close();
    }
});

// Selection must be read back, since the clipboard it's copied to is the sandbox's, not the person's. Two hiding
// places: a focused field, invisible to window.getSelection, and an embedded frame, the ordinary case for a sign-in.
test("the selection is read back out of a field, and out of an embedded frame", { timeout: 120_000 }, async () => {
    const browser = await launch();
    if (browser === undefined) {
        return; // no browser on this box
    }
    try {
        const context = await browser.newContext({ viewport: { width: VIEW_WIDTH, height: VIEW_HEIGHT } });
        const page = await context.newPage();
        await page.goto(`data:text/html,${encodeURIComponent(`<input id="code" value="one-time 314159"><p>page prose</p>`)}`);
        await page.focus("#code");
        const session = await context.newCDPSession(page);

        // Empty is a real answer: the client must not put stale text on the clipboard when nothing is selected.
        expect(await readSelection(page)).toBe("");

        await dispatchInput(session, { type: "key", key: "a", ctrl: true });
        expect(await readSelection(page)).toBe("one-time 314159");

        // Same page's own prose, selected outside any field: the other half of the read.
        await page.evaluate(() => {
            document.querySelector<HTMLInputElement>("#code")!.blur();
            const range = document.createRange();
            range.selectNodeContents(document.querySelector("p")!);
            const selected = window.getSelection()!;
            selected.removeAllRanges();
            selected.addRange(range);
        });
        expect(await readSelection(page)).toBe("page prose");

        // Inside an embedded frame, where the top document has nothing to report.
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
