import { BACKLOG_LIMIT, frameGate, readCodec, splitAccessUnits } from "./videocast.js";

// Bytes between ffmpeg and a browser's decoder, checked as a pure function since a malformed split has no natural error
// (a green smear, not a crash). Shapes tested are what a real capture produces (verified against ffmpeg 5.1 + libx264).

// One NAL unit: four-byte start code, type byte, payload — the form x264 emits for parameter sets and delimiters.
const nal = (type: number, ...payload: number[]): number[] => [0, 0, 0, 1, type, ...payload];

const AUD = 9;
const SPS = 7;
const PPS = 8;
const IDR = 5;
const SLICE = 1;

describe("splitAccessUnits", () => {
    test("a stream is cut where ffmpeg marked the frames, not where the socket happened to break", () => {
        // Two whole frames and the start of a third, exactly as an arbitrary read off a pipe would look.
        const stream = Buffer.from([...nal(AUD), ...nal(SPS, 0x42), ...nal(IDR, 0xaa), ...nal(AUD), ...nal(SLICE, 0xbb), ...nal(AUD), ...nal(SLICE)]);

        const { units, rest } = splitAccessUnits(stream);

        expect(units).toHaveLength(2);
        expect([...units[0]!.bytes]).toEqual([...nal(AUD), ...nal(SPS, 0x42), ...nal(IDR, 0xaa)]);
        expect([...units[1]!.bytes]).toEqual([...nal(AUD), ...nal(SLICE, 0xbb)]);
        // The third frame is incomplete: nothing proves it has ended, so it waits rather than being handed on.
        expect([...rest]).toEqual([...nal(AUD), ...nal(SLICE)]);
    });

    test("a single delimiter yields nothing and keeps everything", () => {
        const partial = Buffer.from([...nal(AUD), ...nal(SPS), ...nal(IDR, 1, 2, 3)]);

        const { units, rest } = splitAccessUnits(partial);

        expect(units).toEqual([]);
        expect([...rest]).toEqual([...partial]);
    });

    test("a stream joined mid-frame drops the orphaned tail", () => {
        const joined = Buffer.from([0x11, 0x22, ...nal(SLICE, 0x33), ...nal(AUD), ...nal(SLICE), ...nal(AUD)]);

        const { units } = splitAccessUnits(joined);

        expect(units).toHaveLength(1);
        expect([...units[0]!.bytes]).toEqual([...nal(AUD), ...nal(SLICE)]);
    });

    test("only a frame carrying an IDR slice is a keyframe", () => {
        const stream = Buffer.from([...nal(AUD), ...nal(SPS), ...nal(PPS), ...nal(IDR), ...nal(AUD), ...nal(SLICE), ...nal(AUD)]);

        const { units } = splitAccessUnits(stream);

        expect(units.map((unit) => unit.key)).toEqual([true, false]);
    });

    // x264 uses the short (3-byte) start code for slices and the long one for parameter sets/delimiters, both in one
    // stream.
    test("both start-code lengths are recognised", () => {
        const short = (type: number, ...payload: number[]): number[] => [0, 0, 1, type, ...payload];
        const stream = Buffer.from([...nal(AUD), ...short(IDR, 0x77), ...nal(AUD), ...short(SLICE)]);

        const { units } = splitAccessUnits(stream);

        expect(units).toHaveLength(1);
        expect(units[0]!.key).toBe(true);
    });

    test("bytes that are not a stream at all yield nothing rather than throwing", () => {
        expect(splitAccessUnits(Buffer.from([])).units).toEqual([]);
        expect(splitAccessUnits(Buffer.from([0, 0, 0])).units).toEqual([]);
        expect([...splitAccessUnits(Buffer.from([1, 2, 3, 4, 5])).rest]).toEqual([1, 2, 3, 4, 5]);
    });
});

describe("readCodec", () => {
    test("the codec string comes from the parameter set the stream carries", () => {
        const keyframe = Buffer.from([...nal(AUD), ...nal(SPS, 0x42, 0xc0, 0x28, 0xff), ...nal(IDR)]);

        expect(readCodec(keyframe)).toBe("avc1.42C028");
    });

    test("a three-byte start code is read at the right offset", () => {
        const keyframe = Buffer.from([...nal(AUD), 0, 0, 1, SPS, 0x4d, 0x40, 0x1f, ...nal(IDR)]);

        expect(readCodec(keyframe)).toBe("avc1.4D401F");
    });

    // Every frame after a keyframe lacks a parameter set; that's normal, not an error, since the codec is announced
    // once.
    test("a frame with no parameter set answers with nothing", () => {
        expect(readCodec(Buffer.from([...nal(AUD), ...nal(SLICE, 1, 2, 3)]))).toBeUndefined();
        expect(readCodec(Buffer.from([...nal(AUD), ...nal(SPS)]))).toBeUndefined();
    });
});

// A viewer slower than the picture, or one whose decoder lost the stream, resumes on a fresh keyframe a restart brings,
// since the periodic one is a minute away; and the restarts never come faster than one a second.
describe("frameGate", () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    const delta = { bytes: Buffer.alloc(10), key: false };
    const key = { bytes: Buffer.alloc(10), key: true };

    test("a backed-up socket drops frames, and once it drains the stream restarts for a keyframe", () => {
        let backlog = 0;
        let restarts = 0;
        const gate = frameGate({ backlog: () => backlog, restart: () => (restarts += 1) });
        gate.started();
        expect(gate.admit(delta)).toBe(true);

        backlog = BACKLOG_LIMIT + 1;
        expect(gate.admit(delta)).toBe(false);
        // Still backed up: a keyframe would only pile on.
        expect(gate.admit(key)).toBe(false);

        backlog = 0;
        // Drained mid-stream: the delta cannot be decoded without what was dropped, so a restart is asked instead.
        expect(gate.admit(delta)).toBe(false);
        expect(gate.admit(delta)).toBe(false);
        jest.advanceTimersByTime(1000);
        expect(restarts).toBe(1);

        gate.started();
        expect(gate.admit(key)).toBe(true);
        expect(gate.admit(delta)).toBe(true);
    });

    test("a keyframe that finds the socket drained resumes the stream without a restart", () => {
        let backlog = BACKLOG_LIMIT + 1;
        let restarts = 0;
        const gate = frameGate({ backlog: () => backlog, restart: () => (restarts += 1) });
        gate.started();
        expect(gate.admit(delta)).toBe(false);
        backlog = 0;
        expect(gate.admit(key)).toBe(true);
        expect(gate.admit(delta)).toBe(true);
        jest.advanceTimersByTime(5000);
        expect(restarts).toBe(0);
    });

    test("a viewer asking for a keyframe gets a restart, no sooner than a second after the last", () => {
        let restarts = 0;
        const gate = frameGate({ backlog: () => 0, restart: () => (restarts += 1) });
        gate.started();
        gate.askKey();
        // Nothing more goes until the fresh stream: the viewer cannot decode it.
        expect(gate.admit(delta)).toBe(false);
        jest.advanceTimersByTime(999);
        expect(restarts).toBe(0);
        jest.advanceTimersByTime(1);
        expect(restarts).toBe(1);
    });

    test("a gate stopped before its restart is due restarts nothing", () => {
        let restarts = 0;
        const gate = frameGate({ backlog: () => 0, restart: () => (restarts += 1) });
        gate.started();
        gate.askKey();
        gate.stop();
        jest.advanceTimersByTime(5000);
        expect(restarts).toBe(0);
    });
});
