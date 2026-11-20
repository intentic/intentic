import { MEDIA_HEADER_LEN, RTC_MESSAGE_MAX } from "@intentic/sandbox-contract/browser-wire";
import { chunkJoiner, encodeMediaMessage, isVideo, mediaPayload, parseMediaHeader } from "./media-wire.js";

// The media socket's 16-byte header as browser-wire's MEDIA_HEADER_LEN doc comment lays it out, byte by byte.

describe("the media header", () => {
    it("is laid out big-endian: kind, flags, id, captured ms, stripe top, index, count, two reserved zeros", () => {
        const message = encodeMediaMessage(
            { kind: 1, key: true, refine: true, id: 0x01020304, capturedMs: 0x0a0b0c0d, stripeTop: 0x0102, stripeIndex: 2, stripeCount: 3 },
            new Uint8Array([0xaa, 0xbb]),
        );
        expect(MEDIA_HEADER_LEN).toBe(16);
        expect([...message]).toEqual([1, 3, 1, 2, 3, 4, 0x0a, 0x0b, 0x0c, 0x0d, 1, 2, 2, 3, 0, 0, 0xaa, 0xbb]);
    });

    it("reads back what was written, and the payload after it", () => {
        const header = { kind: 1, key: false, refine: true, id: 4_000_000_000, capturedMs: 123_456, stripeTop: 440, stripeIndex: 1, stripeCount: 2 };
        const message = encodeMediaMessage(header, new Uint8Array([9, 8, 7]));
        expect(parseMediaHeader(message)).toEqual(header);
        expect([...mediaPayload(message)]).toEqual([9, 8, 7]);
        expect(isVideo(header)).toBe(true);
        expect(isVideo({ ...header, kind: 2 })).toBe(false);
    });

    it("reads a header out of a view into a larger buffer, at the view's own offset", () => {
        const message = encodeMediaMessage({ kind: 2, key: false, refine: false, id: 7, capturedMs: 8, stripeTop: 0, stripeIndex: 0, stripeCount: 1 }, new Uint8Array(0));
        const padded = new Uint8Array(message.byteLength + 5);
        padded.set(message, 5);
        expect(parseMediaHeader(padded.subarray(5))).toMatchObject({ kind: 2, id: 7, capturedMs: 8, stripeCount: 1 });
    });

    it("is undefined for a message shorter than the header", () => {
        expect(parseMediaHeader(new Uint8Array(15))).toBeUndefined();
    });
});

describe("castd's video on a peer connection", () => {
    // A keyframe cut the way castd's src/rtc/chunk.rs cuts it: its header on every chunk, with index and count.
    const cut = (whole: Uint8Array<ArrayBuffer>): Uint8Array[] => {
        const slice = RTC_MESSAGE_MAX - MEDIA_HEADER_LEN;
        const payload = whole.subarray(MEDIA_HEADER_LEN);
        const count = Math.ceil(payload.byteLength / slice);
        return Array.from({ length: count }, (_, index) => {
            const part = payload.subarray(index * slice, (index + 1) * slice);
            const chunk = new Uint8Array(MEDIA_HEADER_LEN + part.byteLength);
            chunk.set(whole.subarray(0, MEDIA_HEADER_LEN));
            chunk.set([index, count], 14);
            chunk.set(part, MEDIA_HEADER_LEN);
            return chunk;
        });
    };
    const keyframe = encodeMediaMessage(
        { kind: 1, key: true, refine: false, id: 9, capturedMs: 5, stripeTop: 0, stripeIndex: 0, stripeCount: 1 },
        new Uint8Array(2 * (RTC_MESSAGE_MAX - MEDIA_HEADER_LEN) + 3).map((_, at) => at % 251),
    );

    it("joins a keyframe's chunks back into the message castd cut, and passes a whole one through", () => {
        const join = chunkJoiner();
        const out = cut(keyframe).map(join);
        expect(out.slice(0, 2)).toEqual([undefined, undefined]);
        expect(out[2]).toEqual(keyframe);
        const small = encodeMediaMessage({ kind: 1, key: false, refine: false, id: 10, capturedMs: 6, stripeTop: 0, stripeIndex: 0, stripeCount: 1 }, new Uint8Array([1]));
        expect(join(small)).toBe(small);
    });

    it("drops a message whose chunks came out of turn", () => {
        const join = chunkJoiner();
        const [first, , third] = cut(keyframe);
        expect([join(first!), join(third!)]).toEqual([undefined, undefined]);
        expect(join(new Uint8Array(3))).toBeUndefined();
    });
});
