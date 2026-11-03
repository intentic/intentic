import { frameStats, framesScript, type RawFrames } from "./frames.js";

/* The frame measurement's page half runs here against a stand-in page: animation frames arrive on a scripted cadence
   from a hand-driven clock, the stall timer fires as soon as nothing else is pending, and the GPU is whatever the test
   says it is. The arithmetic half is plain numbers. */

interface FakePage {
    // The milliseconds between animation frames, repeated; empty means no frame ever comes (a hidden tab).
    readonly cadence: readonly number[];
    readonly gpu?: object;
    readonly secure?: boolean;
    readonly extra?: Record<string, unknown>;
}

const GL_VENDOR = 1;
const GL_RENDERER = 2;
const ANGLE = "ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Laptop GPU Direct3D11 vs_5_0 ps_5_0, D3D11)";

const fakeGl = {
    getExtension: (name: string) => (name === "WEBGL_debug_renderer_info" ? { UNMASKED_VENDOR_WEBGL: GL_VENDOR, UNMASKED_RENDERER_WEBGL: GL_RENDERER } : { loseContext: () => undefined }),
    getParameter: (which: number) => (which === GL_VENDOR ? "Google Inc. (NVIDIA)" : ANGLE),
};

const nvidia = { requestAdapter: async () => ({ info: { vendor: "nvidia", architecture: "lovelace", device: "", description: "" }, isFallbackAdapter: false }) };

// Runs the script the way Runtime.evaluate would, with the page's globals passed in by name.
const runInFakePage = async (script: string, page: FakePage): Promise<RawFrames> => {
    let now = 0;
    let frame = 0;
    const globals = {
        performance: { now: () => now },
        requestAnimationFrame: (callback: (at: number) => void) => {
            if (page.cadence.length === 0) {
                return;
            }
            queueMicrotask(() => {
                now += page.cadence[frame % page.cadence.length] ?? 0;
                frame += 1;
                callback(now);
            });
        },
        // Every timer here is the stall timer: it fires once nothing quicker (a frame, a microtask) is pending.
        setTimeout: (callback: () => void) => setTimeout(callback, 1),
        clearTimeout: (timer: ReturnType<typeof setTimeout>) => clearTimeout(timer),
        document: { createElement: () => ({ getContext: () => fakeGl }), visibilityState: page.cadence.length === 0 ? "hidden" : "visible", hasFocus: () => true },
        navigator: page.gpu === undefined ? {} : { gpu: page.gpu },
        isSecureContext: page.secure ?? true,
        devicePixelRatio: 1.5,
        innerWidth: 1280,
        innerHeight: 720,
        ...page.extra,
    };
    // allow(no-new-func): the script is a string by design (it is sent to a browser); this stands the page up around it.
    // SAFETY: framesScript's expression evaluates to the promise of a RawFrames.
    const run = new Function(...Object.keys(globals), `return ${script};`) as (...values: unknown[]) => Promise<RawFrames>;
    return await run(...Object.values(globals));
};

test("times the asked number of frames and names the GPU that drew them", async () => {
    const raw = await runInFakePage(framesScript({ count: 4, until: undefined, waitMs: 1000, measureMs: 10_000 }), { cadence: [16, 17, 50], gpu: nvidia });
    // The first frame is the start line: four intervals take five frames.
    expect(raw.intervals).toEqual([17, 50, 16, 17]);
    expect(raw).toMatchObject({ ready: true, stalled: false, visibility: "visible", devicePixelRatio: 1.5, viewport: [1280, 720] });
    expect(raw.gpu).toEqual({
        webgl: { found: true, vendor: "Google Inc. (NVIDIA)", renderer: ANGLE },
        webgpu: { found: true, vendor: "nvidia", architecture: "lovelace", device: "", description: "", fallback: false },
    });
});

test("measuring waits for the condition, polled once a frame", async () => {
    let asked = 0;
    const raw = await runInFakePage(framesScript({ count: 2, until: "loaded()", waitMs: 1000, measureMs: 10_000 }), {
        cadence: [10],
        gpu: nvidia,
        extra: { loaded: () => (asked += 1) >= 3 },
    });
    expect(asked).toBe(3);
    expect(raw.waitedMs).toBe(20);
    expect(raw.intervals).toEqual([10, 10]);
});

test("a condition that never comes true measures nothing and says what it last threw", async () => {
    const raw = await runInFakePage(framesScript({ count: 5, until: "game.ready", waitMs: 100, measureMs: 10_000 }), { cadence: [30], gpu: nvidia });
    expect(raw.ready).toBe(false);
    expect(raw.intervals).toEqual([]);
    expect(raw.waitedMs).toBe(120);
    expect(raw.untilError).toContain("game");
});

test("the timing stops at its own cap however few frames came", async () => {
    const raw = await runInFakePage(framesScript({ count: 100, until: undefined, waitMs: 0, measureMs: 1000 }), { cadence: [400], gpu: nvidia });
    expect(raw.intervals).toEqual([400, 400, 400]);
});

test("a hidden tab gets no frames, and the answer says it stalled rather than hanging", async () => {
    const raw = await runInFakePage(framesScript({ count: 10, until: undefined, waitMs: 1000, measureMs: 1000 }), { cadence: [], gpu: nvidia });
    expect(raw).toMatchObject({ stalled: true, visibility: "hidden", intervals: [] });
});

test("no WebGPU says why: an insecure page is told to use localhost", async () => {
    const insecure = await runInFakePage(framesScript({ count: 1, until: undefined, waitMs: 0, measureMs: 1000 }), { cadence: [16], secure: false });
    expect(insecure.gpu.webgpu).toEqual({ found: false, why: "navigator.gpu is missing: the page is not a secure context (use http://localhost or https)" });
    const noAdapter = await runInFakePage(framesScript({ count: 1, until: undefined, waitMs: 0, measureMs: 1000 }), { cadence: [16], gpu: { requestAdapter: async () => null } });
    expect(noAdapter.gpu.webgpu).toEqual({ found: false, why: "requestAdapter() answered null: no usable GPU adapter" });
});

test("the stats are nearest-rank percentiles of the frame times, with hitches past twice the median", () => {
    const intervals = [...Array.from({ length: 18 }, () => 16), 40, 100];
    expect(frameStats(intervals)).toEqual({ frames: 20, p50Ms: 16, p95Ms: 40, maxMs: 100, meanFps: 46.7, hitches: 2 });
    expect(frameStats([])).toBeUndefined();
});
