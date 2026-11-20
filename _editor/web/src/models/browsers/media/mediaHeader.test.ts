// The 16-byte header castd puts before every picture and every packet of sound: read exactly as browser-wire lays it
// out, big-endian, and nothing read from a message too short to carry one.
import { MEDIA_HEADER_LEN } from "@intentic/sandbox-contract/browser-wire";
import { mediaPayload, readMediaHeader, writeMediaMessage } from "./mediaHeader";

it("reads every field castd writes, in its byte order", () => {
    const bytes = new Uint8Array([1, 3, 0x01, 0x02, 0x03, 0x04, 0x00, 0x01, 0x86, 0xa0, 0x03, 0x20, 2, 4, 0, 0, 0xaa, 0xbb]);
    expect(readMediaHeader(bytes)).toEqual({
        kind: `video`,
        key: true,
        refine: true,
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
