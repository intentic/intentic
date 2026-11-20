import { analyze, newPictures } from "./analysis.js";
import type { DecoderLog, InputRecord, MarkerRecord } from "./client/decoder.js";
import { markerClock } from "./marker.js";

// Raw viewer events to a run's numbers, by value: which decoded frames count as new, what each latency is measured
// from, and what falls outside the window.

const BASE = 1_790_000_000_000;

// A marker drawn at `drawnAt` (ms after BASE) and decoded at `decodedAt`.
const marker = (frame: number, drawnAt: number, decodedAt: number): MarkerRecord => [frame, markerClock(BASE + drawnAt), BASE + decodedAt];

const logOf = (overrides: Partial<DecoderLog> = {}): DecoderLog => ({
    picture: { width: 1280, height: 880 },
    markers: [],
    decoded: [],
    received: [],
    inputs: [],
    markerErrors: 0,
    decodeErrors: 0,
    keyframes: 1,
    closed: null,
    carrier: "socket",
    peerOpenedAt: null,
    peerClosed: null,
    ...overrides,
});

const window = { from: BASE, to: BASE + 2000 };

describe("newPictures", () => {
    it("keeps the first decode of each newer frame and drops repeats and stragglers", () => {
        const markers = [marker(1, 0, 40), marker(1, 0, 73), marker(3, 33, 106), marker(2, 16, 110), marker(4, 50, 140)];
        expect(newPictures(markers).map(([frame]) => frame)).toEqual([1, 3, 4]);
    });

    it("counts on across the 16-bit counter's wrap", () => {
        expect(newPictures([marker(65_535, 0, 40), marker(0, 16, 60), marker(1, 33, 80)]).map(([frame]) => frame)).toEqual([65_535, 0, 1]);
    });
});

describe("analyze", () => {
    it("measures drawn → decoded for new pictures inside the window only", () => {
        const markers = [marker(1, -100, -50), marker(2, 100, 145), marker(2, 100, 178), marker(3, 200, 255), marker(4, 2100, 2150)];
        const result = analyze(logOf({ markers }), window, { moving: true, firstSeen: undefined });
        expect(result.latencyMs).toEqual({ n: 2, p50: 45, p99: 55, mean: 50, max: 55 });
    });

    it("splits the latency at the display probe's first sighting of each frame", () => {
        const markers = [marker(1, 100, 150), marker(2, 200, 260)];
        const firstSeen = new Map([
            [1, BASE + 110],
            [2, BASE + 205],
        ]);
        const result = analyze(logOf({ markers }), window, { moving: true, firstSeen });
        expect(result.displayMs).toMatchObject({ n: 2, p50: 5, max: 10 });
        expect(result.pipelineMs).toMatchObject({ n: 2, p50: 40, max: 55 });
    });

    it("ignores a sighting later than the decode, which belongs to another lap of the counter", () => {
        const result = analyze(logOf({ markers: [marker(1, 100, 150)] }), window, { moving: true, firstSeen: new Map([[1, BASE + 1900]]) });
        expect(result.displayMs.n).toBe(0);
    });

    it("counts frames, unique frames per whole second, bytes and stalls over the window", () => {
        // A new picture every 50 ms for the first second, then nothing: the second second is one long stall.
        const markers = Array.from({ length: 20 }, (_, index) => marker(index + 1, index * 50, index * 50 + 30));
        const decoded = markers.map(([, , at]) => at);
        const received: (readonly [number, number])[] = [
            [BASE + 10, 125_000],
            [BASE + 1500, 125_000],
            [BASE + 2500, 999_999],
        ];
        const result = analyze(logOf({ markers, decoded, received }), window, { moving: true, firstSeen: undefined });
        expect(result.framesPerSec).toBe(10);
        expect(result.uniqueFps).toEqual({ mean: 10, min: 0, p10: 0 });
        expect(result.mbps).toBe(1);
        expect(result.stalls).toBe(1);
        // The last picture was decoded at +980; nothing new came in the 1020 ms to the window's end.
        expect(result.maxGapMs).toBe(1020);
    });

    it("leaves stalls unjudged on a page that does not move by itself", () => {
        expect(analyze(logOf(), window, { moving: false, firstSeen: undefined })).toMatchObject({ stalls: null, maxGapMs: null });
    });

    it("times a keystroke to its echo, splits off the input path, and counts the misses", () => {
        const inputs: InputRecord[] = [
            { kind: "key", at: BASE + 100, expect: 1, echoedAt: BASE + 160 },
            { kind: "key", at: BASE + 400, expect: 2, echoedAt: null },
            { kind: "paste", at: BASE + 800, expect: 10_002, echoedAt: BASE + 950 },
        ];
        // The page saw key 1 at +108 and drew it; the echo was decoded at +160.
        const markers = [marker(1, 108, 160), marker(10_002, 820, 950)];
        const result = analyze(logOf({ markers, inputs }), window, { moving: false, firstSeen: undefined });
        expect(result.keyMs).toMatchObject({ n: 1, p50: 60 });
        expect(result.keyInputMs).toMatchObject({ n: 1, p50: 8 });
        expect(result.pasteMs).toMatchObject({ n: 1, p50: 150 });
        expect(result.inputMissed).toBe(1);
    });
});
