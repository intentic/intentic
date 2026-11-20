// The DataChannel's cuts, both ways: castd's long video message joined back byte for byte before the decoder, and the
// viewer's long JSON cut into chunks castd joins (castd's src/rtc/chunk.rs holds the other half of each).
import { MEDIA_HEADER_LEN, RTC_MESSAGE_MAX } from "@intentic/sandbox-contract/browser-wire";
import { readMediaHeader, readVideo, rectPayload, writeMediaMessage } from "./mediaHeader";
import { inputMessages, mediaJoiner } from "./mediaRtcWire";

// A video message as castd writes it: kind video, the key flag, frame `id`, then `length` payload bytes.
const message = (id: number, length: number): Uint8Array<ArrayBuffer> => {
    const bytes = new Uint8Array(MEDIA_HEADER_LEN + length);
    bytes[0] = 1;
    bytes[1] = 1;
    new DataView(bytes.buffer).setUint32(2, id);
    for (let at = 0; at < length; at += 1) {
        bytes[MEDIA_HEADER_LEN + at] = (at * 7) % 256;
    }
    return bytes;
};

// castd's chunk.rs, restated: each chunk the header with its index and count, then the next slice.
const castdChunks = (whole: Uint8Array<ArrayBuffer>): ArrayBuffer[] => {
    const slice = RTC_MESSAGE_MAX - MEDIA_HEADER_LEN;
    const payload = whole.subarray(MEDIA_HEADER_LEN);
    const count = Math.ceil(payload.byteLength / slice);
    return Array.from({ length: count }, (_, index) => {
        const part = payload.subarray(index * slice, (index + 1) * slice);
        const chunk = new Uint8Array(MEDIA_HEADER_LEN + part.byteLength);
        chunk.set(whole.subarray(0, MEDIA_HEADER_LEN));
        chunk[14] = index;
        chunk[15] = count;
        chunk.set(part, MEDIA_HEADER_LEN);
        return chunk.buffer;
    });
};

it("passes a message that was never cut straight through", () => {
    const join = mediaJoiner();
    const whole = message(3, 100);
    expect(join(whole.buffer)).toBe(whole.buffer);
});

it("joins a keyframe's chunks back into exactly the message castd cut", () => {
    const join = mediaJoiner();
    const whole = message(9, 3 * (RTC_MESSAGE_MAX - MEDIA_HEADER_LEN) + 17);
    const chunks = castdChunks(whole);
    expect(chunks).toHaveLength(4);
    const out = chunks.map(join);
    expect(out.slice(0, 3)).toEqual([undefined, undefined, undefined]);
    expect(new Uint8Array(out[3]!)).toEqual(whole);
});

it("drops a message whose chunks came out of turn, and joins the next one whole", () => {
    const join = mediaJoiner();
    const [first, second, third] = castdChunks(message(4, 2 * (RTC_MESSAGE_MAX - MEDIA_HEADER_LEN) + 1));
    expect(join(first!)).toBeUndefined();
    expect(join(third!)).toBeUndefined();
    expect(join(second!)).toBeUndefined();
    const next = message(5, 2 * (RTC_MESSAGE_MAX - MEDIA_HEADER_LEN));
    const [a, b] = castdChunks(next);
    expect(join(a!)).toBeUndefined();
    expect(new Uint8Array(join(b!)!)).toEqual(next);
    expect(join(new ArrayBuffer(3))).toBeUndefined();
});

it("sends a JSON message that fits as itself, and a longer one as chunks castd joins", () => {
    expect(inputMessages(`{"type":"keyframe"}`)).toEqual([`{"type":"keyframe"}`]);
    const paste = JSON.stringify({ type: `text`, text: `ą`.repeat(RTC_MESSAGE_MAX) });
    const chunks = inputMessages(paste);
    expect(chunks).toHaveLength(Math.ceil(new TextEncoder().encode(paste).byteLength / (RTC_MESSAGE_MAX - 2)));
    const parts = chunks.flatMap((chunk) => (chunk instanceof Uint8Array ? [chunk] : []));
    expect(parts).toHaveLength(chunks.length);
    expect(Math.max(...parts.map((chunk) => chunk.byteLength))).toBeLessThanOrEqual(RTC_MESSAGE_MAX);
    expect(parts.map((chunk) => [chunk[0], chunk[1]])).toEqual(parts.map((_, index) => [index, parts.length]));
    const joined = new Uint8Array(parts.reduce((size, chunk) => size + chunk.byteLength - 2, 0));
    let at = 0;
    for (const chunk of parts) {
        joined.set(chunk.subarray(2), at);
        at += chunk.byteLength - 2;
    }
    expect(new TextDecoder().decode(joined)).toBe(paste);
});

it("sends nothing on the peer for a message past 255 chunks: the socket takes it", () => {
    expect(inputMessages(`x`.repeat(255 * (RTC_MESSAGE_MAX - 2) + 1))).toEqual([]);
});

it("joins a clipped frame's chunks into its rectangle and the whole access unit after it", () => {
    const join = mediaJoiner();
    const unit = Uint8Array.from({ length: 2 * RTC_MESSAGE_MAX }, (_, at) => (at * 13) % 256);
    const clipped = writeMediaMessage(
        { kind: `video`, key: true, refine: false, clip: true, id: 6, captureMs: 0, stripeTop: 0, stripeIndex: 0, stripeCount: 1 },
        rectPayload({ x: 640, y: 360, width: 320, height: 200 }, unit),
    );
    const joined = castdChunks(clipped).map(join).at(-1);
    const bytes = new Uint8Array(joined ?? new ArrayBuffer(0));
    const video = readVideo(readMediaHeader(bytes)!, bytes);
    expect(video.clip).toEqual({ x: 640, y: 360, width: 320, height: 200 });
    expect(video.unit).toEqual(unit);
});
