import { describe, expect, test } from "vitest";
import { readCodec, splitAccessUnits } from "./videocast.js";

/* THE BYTES BETWEEN FFMPEG AND A BROWSER'S DECODER, checked without either.
 *
 * The framing is the load-bearing part of the video path and the part with no natural error: a client handed
 * half a frame does not throw, it shows a green smear or nothing at all, and the only way to tell that from a
 * page that has stopped moving is to already know. So the split is a pure function over bytes and is tested as
 * one — the shapes below are the ones a real capture produces (verified against ffmpeg 5.1 + libx264: a
 * keyframe carries AUD, SPS, PPS, SEI and IDR slices; a delta carries AUD and non-IDR slices).
 */

// One NAL unit: a four-byte start code, the type byte, and a little payload. Four-byte codes throughout,
// which is what x264 emits for parameter sets and delimiters.
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

    /* A FRAME IS ONLY WHOLE ONCE THE NEXT ONE HAS STARTED. Emitting on the first delimiter would hand the
     * decoder a frame that is still being written, which is the failure this whole framing exists to prevent —
     * and it would look exactly like a page that stopped repainting. */
    test("a single delimiter yields nothing and keeps everything", () => {
        const partial = Buffer.from([...nal(AUD), ...nal(SPS), ...nal(IDR, 1, 2, 3)]);

        const { units, rest } = splitAccessUnits(partial);

        expect(units).toEqual([]);
        expect([...rest]).toEqual([...partial]);
    });

    // Bytes before the first delimiter belong to a frame whose beginning was never seen. A decoder cannot use
    // them, so they are dropped rather than prefixed onto the first good frame.
    test("a stream joined mid-frame drops the orphaned tail", () => {
        const joined = Buffer.from([0x11, 0x22, ...nal(SLICE, 0x33), ...nal(AUD), ...nal(SLICE), ...nal(AUD)]);

        const { units } = splitAccessUnits(joined);

        expect(units).toHaveLength(1);
        expect([...units[0]!.bytes]).toEqual([...nal(AUD), ...nal(SLICE)]);
    });

    /* WHICH FRAME CAN START A STREAM is the one thing a VideoDecoder cannot work out for itself, so getting it
     * wrong is a decoder configured against a delta frame and a picture that never appears. */
    test("only a frame carrying an IDR slice is a keyframe", () => {
        const stream = Buffer.from([...nal(AUD), ...nal(SPS), ...nal(PPS), ...nal(IDR), ...nal(AUD), ...nal(SLICE), ...nal(AUD)]);

        const { units } = splitAccessUnits(stream);

        expect(units.map((unit) => unit.key)).toEqual([true, false]);
    });

    /* THREE-BYTE START CODES OCCUR IN THE SAME STREAM as four-byte ones — x264 uses the short form for slices —
     * so a scanner that matched only one form would run two NALs together and mis-read the type of the second. */
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
    /* READ, NOT WRITTEN DOWN. The three bytes after the SPS header are profile, constraint flags and level, and
     * they are x264's business rather than ours: asking for `-profile:v baseline` at 1280x880 produces
     * 42/C0/28 on the build this image pins, where the plausible guess is 42/E0/28. A decoder configured from
     * the wrong string is a black picture with no error worth reading, so it is taken from the stream. */
    test("the codec string comes from the parameter set the stream carries", () => {
        const keyframe = Buffer.from([...nal(AUD), ...nal(SPS, 0x42, 0xc0, 0x28, 0xff), ...nal(IDR)]);

        expect(readCodec(keyframe)).toBe("avc1.42C028");
    });

    test("a three-byte start code is read at the right offset", () => {
        const keyframe = Buffer.from([...nal(AUD), 0, 0, 1, SPS, 0x4d, 0x40, 0x1f, ...nal(IDR)]);

        expect(readCodec(keyframe)).toBe("avc1.4D401F");
    });

    // Every frame after a keyframe carries no parameter set, which is not an error: the codec was announced
    // once, on the first one, and is not asked for again.
    test("a frame with no parameter set answers with nothing", () => {
        expect(readCodec(Buffer.from([...nal(AUD), ...nal(SLICE, 1, 2, 3)]))).toBeUndefined();
        expect(readCodec(Buffer.from([...nal(AUD), ...nal(SPS)]))).toBeUndefined();
    });
});
