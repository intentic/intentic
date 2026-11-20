// The 16-byte header castd puts before every picture and every packet of sound: read exactly as browser-wire lays it
// out, big-endian, and nothing read from a message too short to carry one. And the rectangle an exact picture's
// messages start with: a clipped frame's, before its access unit, and a lossless copy's, before its pixels.
import { MEDIA_CLIP_LEN, MEDIA_HEADER_LEN } from "@intentic/sandbox-contract/browser-wire";
import { mediaPayload, readExactCopy, readMediaHeader, readRect, readVideo, rectPayload, writeMediaMessage } from "./mediaHeader";

it("reads every field castd writes, in its byte order", () => {
    const bytes = new Uint8Array([1, 3, 0x01, 0x02, 0x03, 0x04, 0x00, 0x01, 0x86, 0xa0, 0x03, 0x20, 2, 4, 0, 0, 0xaa, 0xbb]);
    expect(readMediaHeader(bytes)).toEqual({
        kind: `video`,
        key: true,
        refine: true,
        clip: false,
        id: 0x01020304,
        captureMs: 100_000,
        stripeTop: 800,
        stripeIndex: 2,
        stripeCount: 4,
    });
    expect([...mediaPayload(bytes)]).toEqual([0xaa, 0xbb]);
});

it("reads a header inside a larger buffer, at its own offset", () => {
    const message = writeMediaMessage(
        { kind: `audio`, key: false, refine: false, id: 0, captureMs: 42, stripeTop: 0, stripeIndex: 0, stripeCount: 0 },
        new Uint8Array([9]),
    );
    const padded = new Uint8Array(message.byteLength + 3);
    padded.set(message, 3);
    expect(readMediaHeader(padded.subarray(3))).toEqual({
        kind: `audio`,
        key: false,
        refine: false,
        clip: false,
        id: 0,
        captureMs: 42,
        stripeTop: 0,
        stripeIndex: 0,
        stripeCount: 0,
    });
});

it("writes what it reads, the top id and capture time included", () => {
    const header = {
        kind: `video`,
        key: false,
        refine: true,
        clip: true,
        id: 0xffff_ffff,
        captureMs: 0xffff_fffe,
        stripeTop: 65_535,
        stripeIndex: 255,
        stripeCount: 255,
    } as const;
    expect(readMediaHeader(writeMediaMessage(header, new Uint8Array()))).toEqual(header);
});

it("reads nothing from a message shorter than the header, and names a kind it does not know", () => {
    expect(readMediaHeader(new Uint8Array(MEDIA_HEADER_LEN - 1))).toBeUndefined();
    const unknown = new Uint8Array(MEDIA_HEADER_LEN);
    unknown[0] = 9;
    expect(readMediaHeader(unknown)?.kind).toBe(`unknown`);
});

const base = { key: false, refine: false, captureMs: 7, stripeTop: 0, stripeIndex: 0, stripeCount: 1 } as const;

it("reads a clipped frame's rectangle, big-endian, and hands the decoder only the access unit after it", () => {
    // Flags 4 (clip) | 1 (key); the rectangle x 0x0102, y 3, width 0x0400, height 0x0300, then the access unit.
    const bytes = new Uint8Array([1, 5, 0, 0, 0, 9, 0, 0, 0, 7, 0, 0, 0, 1, 0, 0, 0x01, 0x02, 0, 3, 0x04, 0x00, 0x03, 0x00, 0, 0, 0, 1, 0x65]);
    const header = readMediaHeader(bytes)!;
    expect(header).toMatchObject({ kind: `video`, key: true, refine: false, clip: true, id: 9 });
    const video = readVideo(header, bytes);
    expect(video.clip).toEqual({ x: 258, y: 3, width: 1024, height: 768 });
    expect([...video.unit]).toEqual([0, 0, 0, 1, 0x65]);
});

it("hands an unclipped frame's whole payload to the decoder, drawn whole", () => {
    const bytes = writeMediaMessage({ ...base, kind: `video`, id: 1 }, new Uint8Array([0, 0, 0, 1, 0x41]));
    const video = readVideo(readMediaHeader(bytes)!, bytes);
    expect(video.clip).toBeUndefined();
    expect([...video.unit]).toEqual([0, 0, 0, 1, 0x41]);
});

it("draws a clipped frame too short for its rectangle nowhere, and decodes nothing of it", () => {
    const bytes = writeMediaMessage({ ...base, kind: `video`, clip: true, id: 1 }, new Uint8Array([0, 1, 0, 2]));
    const video = readVideo(readMediaHeader(bytes)!, bytes);
    expect(video).toEqual({ unit: new Uint8Array(), clip: { x: 0, y: 0, width: 0, height: 0 } });
});

it("reads a lossless copy's rectangle and exactly its pixels, and the frame it is drawn after", () => {
    const pixels = Uint8Array.from({ length: 2 * 3 * 4 + 5 }, (_, at) => at);
    const bytes = writeMediaMessage({ ...base, kind: `lossless`, id: 41 }, rectPayload({ x: 10, y: 20, width: 2, height: 3 }, pixels));
    expect(readMediaHeader(bytes)).toMatchObject({ kind: `lossless`, id: 41, clip: false });
    const copy = readExactCopy(bytes);
    expect(copy?.rect).toEqual({ x: 10, y: 20, width: 2, height: 3 });
    // Width × height × 4 bytes, whatever trails them.
    expect([...(copy?.pixels ?? [])]).toEqual([...pixels.subarray(0, 24)]);
});

it("reads no lossless copy whose pixels fall short of its rectangle, nor a rectangle from too few bytes", () => {
    const short = writeMediaMessage({ ...base, kind: `lossless`, id: 1 }, rectPayload({ x: 0, y: 0, width: 2, height: 2 }, new Uint8Array(15)));
    expect(readExactCopy(short)).toBeUndefined();
    expect(readRect(new Uint8Array(MEDIA_CLIP_LEN - 1))).toBeUndefined();
    const empty = writeMediaMessage({ ...base, kind: `lossless`, id: 1 }, rectPayload({ x: 4, y: 5, width: 0, height: 9 }, new Uint8Array()));
    expect(readExactCopy(empty)).toEqual({ rect: { x: 4, y: 5, width: 0, height: 9 }, pixels: new Uint8Array() });
});

it("writes a rectangle as castd does, x, y, width and height big-endian", () => {
    expect([...rectPayload({ x: 0x0102, y: 0x0304, width: 0x0506, height: 0xffff }, new Uint8Array([9]))]).toEqual([1, 2, 3, 4, 5, 6, 255, 255, 9]);
});
