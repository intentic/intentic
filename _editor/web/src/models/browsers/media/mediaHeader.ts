import { MEDIA_FLAGS, MEDIA_HEADER_LEN, MEDIA_KINDS } from "@intentic/sandbox-contract/browser-wire";

// The 16 bytes every binary message on a media socket starts with, as browser-wire lays them out (MEDIA_HEADER_LEN):
// kind, flags, frame id (u32), capture time in ms since the viewer's latest `hello` (u32), the stripe's top row (u16),
// its index and how many stripes the picture is cut into, then two reserved bytes. Big-endian throughout.

export interface MediaHeader {
    readonly kind: `video` | `audio` | `unknown`;
    // An IDR a decoder can start on; for a stripe, that stripe's own decoder.
    readonly key: boolean;
    // castd sharpening content that has gone still (paint-over): drawn like any other frame.
    readonly refine: boolean;
    // What an `ack` names; every stripe of one frame carries the same id.
    readonly id: number;
    readonly captureMs: number;
    readonly stripeTop: number;
    readonly stripeIndex: number;
    // 1 when the picture is whole; zero on audio, which is no picture.
    readonly stripeCount: number;
}

const kindOf = (byte: number): MediaHeader[`kind`] => {
    if (byte === MEDIA_KINDS.video) {
        return `video`;
    }
    return byte === MEDIA_KINDS.audio ? `audio` : `unknown`;
};

/** The header of one binary message, or undefined for one too short to carry it. */
export const readMediaHeader = (bytes: Uint8Array): MediaHeader | undefined => {
    if (bytes.byteLength < MEDIA_HEADER_LEN) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, MEDIA_HEADER_LEN);
    const flags = view.getUint8(1);
    return {
        kind: kindOf(view.getUint8(0)),
        key: (flags & MEDIA_FLAGS.key) !== 0,
        refine: (flags & MEDIA_FLAGS.refine) !== 0,
        id: view.getUint32(2),
        captureMs: view.getUint32(6),
        stripeTop: view.getUint16(10),
        stripeIndex: view.getUint8(12),
        stripeCount: view.getUint8(13),
    };
};

/** The payload after the header: one H.264 access unit (Annex B) or one Opus packet. */
export const mediaPayload = (bytes: Uint8Array): Uint8Array => bytes.subarray(MEDIA_HEADER_LEN);

/** A message as castd writes one, for a stub server and the tests. */
export const writeMediaMessage = (
    header: Omit<MediaHeader, `kind`> & { readonly kind: `video` | `audio` },
    payload: Uint8Array,
): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(MEDIA_HEADER_LEN + payload.byteLength);
    const view = new DataView(out.buffer);
    view.setUint8(0, MEDIA_KINDS[header.kind]);
    view.setUint8(1, (header.key ? MEDIA_FLAGS.key : 0) | (header.refine ? MEDIA_FLAGS.refine : 0));
    view.setUint32(2, header.id >>> 0);
    view.setUint32(6, header.captureMs >>> 0);
    view.setUint16(10, header.stripeTop);
    view.setUint8(12, header.stripeIndex);
    view.setUint8(13, header.stripeCount);
    out.set(payload, MEDIA_HEADER_LEN);
    return out;
};
