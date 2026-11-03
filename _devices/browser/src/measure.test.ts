import type { CdpParams, CdpSession } from "./cdp.js";
import { captureScreenshot, evaluateWithin, pngSize, valueText } from "./measure.js";
import { BrowserError, BrowserTimeoutError } from "./types.js";

/* Screenshots, scripts and their deadlines at the CDP boundary: what is asked of the browser and how its answers are
   read. The browser is a scripted session that records every call and answers from a table by method. */

interface Call {
    readonly method: string;
    readonly params: CdpParams;
    readonly timeoutMs: number | undefined;
}

// A PNG header of the given size: the signature, then IHDR's length, type, width and height.
const pngOf = (width: number, height: number): Buffer => {
    const header = Buffer.alloc(24);
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
    header.writeUInt32BE(13, 8);
    header.write("IHDR", 12);
    header.writeUInt32BE(width, 16);
    header.writeUInt32BE(height, 20);
    return header;
};

const scripted = (answers: Readonly<Record<string, (params: CdpParams) => CdpParams>>) => {
    const calls: Call[] = [];
    const session: CdpSession = {
        send: async <T,>(method: string, params: CdpParams = {}, timeoutMs?: number): Promise<T> => {
            calls.push({ method, params, timeoutMs });
            const answer = answers[method];
            if (answer === undefined) {
                throw new BrowserError(`unexpected ${method}`);
            }
            // SAFETY: each test's table answers what its method's caller reads.
            return answer(params) as T;
        },
        close: () => undefined,
    };
    return { session, calls };
};

test("a PNG's size is read from its own header", () => {
    expect(pngSize(pngOf(1456, 819))).toEqual({ width: 1456, height: 819 });
    expect(pngSize(Buffer.alloc(3))).toEqual({ width: 0, height: 0 });
});

test("a canvas is captured from the GPU's surface, clipped to it and shrunk to what a model reads whole", async () => {
    const { session, calls } = scripted({
        "Page.bringToFront": () => ({}),
        "Runtime.evaluate": () => ({ result: { type: "object", value: { x: 0, y: 40, width: 1920, height: 1080, dpr: 1.5, what: "canvas#game" } } }),
        "Page.captureScreenshot": () => ({ data: pngOf(1429, 804).toString("base64") }),
    });
    const shot = await captureScreenshot(session, "canvas");
    expect(calls.map((call) => call.method)).toEqual(["Page.bringToFront", "Runtime.evaluate", "Page.captureScreenshot"]);
    expect(String(calls[1]?.params["expression"])).toContain('document.querySelector("canvas")');
    const capture = calls[2]?.params;
    expect(capture).toMatchObject({ format: "png", fromSurface: true, captureBeyondViewport: false, clip: { x: 0, y: 40, width: 1920, height: 1080 } });
    // 2880×1620 device pixels fitted to 1.15 megapixels: 1429 wide, so the browser scales by 1429/2880.
    expect(capture).toMatchObject({ clip: { scale: expect.closeTo(1429 / 2880, 5) } });
    expect(shot).toMatchObject({ width: 1429, height: 804, what: "canvas#game", cssWidth: 1920, cssHeight: 1080, devicePixelRatio: 1.5 });
});

test("a small page is captured at its own size, never enlarged", async () => {
    const { session, calls } = scripted({
        "Page.bringToFront": () => ({}),
        "Runtime.evaluate": () => ({ result: { type: "object", value: { x: 0, y: 0, width: 800, height: 600, dpr: 1, what: "the visible page" } } }),
        "Page.captureScreenshot": () => ({ data: pngOf(800, 600).toString("base64") }),
    });
    await captureScreenshot(session, undefined);
    expect(calls[2]?.params).toMatchObject({ clip: { scale: 1 } });
    expect(String(calls[1]?.params["expression"])).not.toContain("querySelector");
});

test("an element that is not there is the page's own error, said as such", async () => {
    const { session } = scripted({
        "Page.bringToFront": () => ({}),
        "Runtime.evaluate": () => ({ exceptionDetails: { text: "Uncaught", exception: { description: 'Error: No element on this page matches "#nope".' } } }),
    });
    await expect(captureScreenshot(session, "#nope")).rejects.toThrow('The page threw: Error: No element on this page matches "#nope".');
});

test("a script runs with its deadline in the browser and a little longer on the wire", async () => {
    const { session, calls } = scripted({ "Runtime.evaluate": () => ({ result: { type: "object", value: { fps: 60, gpu: "nvidia" } } }) });
    expect(await evaluateWithin(session, "game.stats()", 8000)).toBe('{\n  "fps": 60,\n  "gpu": "nvidia"\n}');
    expect(calls[0]).toEqual({
        method: "Runtime.evaluate",
        params: { expression: "game.stats()", returnByValue: true, awaitPromise: true, userGesture: true, timeout: 8000 },
        timeoutMs: 13_000,
    });
});

test("a script that never settles is reported against its own deadline", async () => {
    const session: CdpSession = {
        send: async (method) => await Promise.reject(new BrowserTimeoutError(`The page did not answer "${method}" within 13s.`)),
        close: () => undefined,
    };
    await expect(evaluateWithin(session, "new Promise(() => {})", 8000)).rejects.toThrow("The script did not finish within 8 s.");
});

test("values the JSON cannot carry read as the console writes them", () => {
    expect(valueText({ type: "undefined" })).toBe("undefined");
    expect(valueText({ type: "number", unserializableValue: "Infinity" })).toBe("Infinity");
    expect(valueText({ type: "string", value: "ok" })).toBe('"ok"');
    expect(valueText({ type: "function", description: "function draw() {}" })).toBe("function draw() {}");
    expect(valueText({ type: "string", value: "x".repeat(20_010) })).toContain("(cut here: 12 more characters)");
});
