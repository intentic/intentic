import { MEDIA_CLIP_LEN, MEDIA_FLAGS, MEDIA_HEADER_LEN, MEDIA_KINDS } from "@intentic/sandbox-contract/browser-wire";

// The 16 bytes every binary message on a media socket starts with, as browser-wire lays them out (MEDIA_HEADER_LEN):
// kind, flags, frame id (u32), capture time in ms since the viewer's latest `hello` (u32), the stripe's top row (u16),
// its index and how many stripes the picture is cut into, then two reserved bytes. Big-endian throughout.
//
// A viewer that asked for exact pictures (MEDIA_LOSSLESS_QUERY) and reaches castd on this computer's loopback gets two
// more shapes of payload, each starting with a rectangle of the picture (MEDIA_CLIP_LEN bytes: x, y, width, height, u16
// each): a `clip`ped video frame, whose access unit follows its rectangle and is drawn only inside it, and a `lossless`
// message, the exact pixels of its rectangle.

export interface MediaHeader {
    readonly kind: `video` | `audio` | `lossless` | `unknown`;
    // An IDR a decoder can start on; for a stripe, that stripe's own decoder.
    readonly key: boolean;
    // castd sharpening content that has gone still (paint-over): drawn like any other frame.
    readonly refine: boolean;
    // A video frame drawn only inside the rectangle its payload starts with: the rest of the picture is exact already.
    readonly clip: boolean;
    // What an `ack` names; every stripe of one frame carries the same id. On a lossless message, the last video frame
    // castd sent before it, which it is drawn after.
    readonly id: number;
    readonly captureMs: number;
    readonly stripeTop: number;
    readonly stripeIndex: number;
    // 1 when the picture is whole; zero on audio, which is no picture.
    readonly stripeCount: number;
}

/** A rectangle of the picture, in its own pixels. */
export interface PictureRect {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
}

/** A video message's picture: its access unit, and the rectangle it is drawn in where castd clipped it. */
export interface MediaVideo {
    readonly unit: Uint8Array;
    // Undefined: drawn whole. An empty one: decoded, drawn nowhere.
    readonly clip: PictureRect | undefined;
}

/** An exact copy of a rectangle of the picture: width × height pixels of B, G, R and one unused byte, row after row. */
export interface ExactCopy {
    readonly rect: PictureRect;
    readonly pixels: Uint8Array<ArrayBuffer>;
}

const NOWHERE: PictureRect = { x: 0, y: 0, width: 0, height: 0 };

const KINDS: ReadonlyMap<number, MediaHeader[`kind`]> = new Map([
    [MEDIA_KINDS.video, `video`],
    [MEDIA_KINDS.audio, `audio`],
    [MEDIA_KINDS.lossless, `lossless`],
]);

/** The header of one binary message, or undefined for one too short to carry it. */
export const readMediaHeader = (bytes: Uint8Array): MediaHeader | undefined => {
    if (bytes.byteLength < MEDIA_HEADER_LEN) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, MEDIA_HEADER_LEN);
    const flags = view.getUint8(1);
    return {
        kind: KINDS.get(view.getUint8(0)) ?? `unknown`,
        key: (flags & MEDIA_FLAGS.key) !== 0,
        refine: (flags & MEDIA_FLAGS.refine) !== 0,
        clip: (flags & MEDIA_FLAGS.clip) !== 0,
        id: view.getUint32(2),
        captureMs: view.getUint32(6),
        stripeTop: view.getUint16(10),
        stripeIndex: view.getUint8(12),
        stripeCount: view.getUint8(13),
    };
};

/** The payload after the header: one H.264 access unit (Annex B, after its rectangle when clipped) or one Opus packet. */
export const mediaPayload = <Buffer extends ArrayBufferLike>(bytes: Uint8Array<Buffer>): Uint8Array<Buffer> => bytes.subarray(MEDIA_HEADER_LEN);

/** The rectangle a payload starts with, and what follows it; undefined for a payload too short to carry one. */
export const readRect = <Buffer extends ArrayBufferLike>(
    payload: Uint8Array<Buffer>,
): { readonly rect: PictureRect; readonly rest: Uint8Array<Buffer> } | undefined => {
    if (payload.byteLength < MEDIA_CLIP_LEN) {
        return undefined;
    }
    const view = new DataView(payload.buffer, payload.byteOffset, MEDIA_CLIP_LEN);
    return {
        rect: { x: view.getUint16(0), y: view.getUint16(2), width: view.getUint16(4), height: view.getUint16(6) },
        rest: payload.subarray(MEDIA_CLIP_LEN),
    };
};

/**
 * A video message's access unit and where it is drawn. A clipped one too short for its rectangle is castd's bug: it is
 * decoded as nothing and drawn nowhere, so it is still acked and its stripe asks for a keyframe.
 */
export const readVideo = (header: MediaHeader, bytes: Uint8Array): MediaVideo => {
    const payload = mediaPayload(bytes);
    if (!header.clip) {
        return { unit: payload, clip: undefined };
    }
    const clipped = readRect(payload);
    return clipped === undefined ? { unit: payload.subarray(payload.byteLength), clip: NOWHERE } : { unit: clipped.rest, clip: clipped.rect };
};

/** A lossless message's rectangle and its pixels, or undefined when the pixels do not fill the rectangle. */
export const readExactCopy = (bytes: Uint8Array<ArrayBuffer>): ExactCopy | undefined => {
    const copy = readRect(mediaPayload(bytes));
    const length = (copy?.rect.width ?? 0) * (copy?.rect.height ?? 0) * 4;
    if (copy === undefined || copy.rest.byteLength < length) {
        return undefined;
    }
    return { rect: copy.rect, pixels: copy.rest.subarray(0, length) };
};

/** A rectangle and what follows it, as castd starts a clipped frame's payload and a lossless message's. */
export const rectPayload = (rect: PictureRect, rest: Uint8Array): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(MEDIA_CLIP_LEN + rest.byteLength);
    const view = new DataView(out.buffer);
    view.setUint16(0, rect.x);
    view.setUint16(2, rect.y);
    view.setUint16(4, rect.width);
    view.setUint16(6, rect.height);
    out.set(rest, MEDIA_CLIP_LEN);
    return out;
};

/** A message as castd writes one, for a stub server and the tests. */
export const writeMediaMessage = (
    header: Omit<MediaHeader, `kind` | `clip`> & { readonly kind: Exclude<MediaHeader[`kind`], `unknown`>; readonly clip?: boolean },
    payload: Uint8Array,
): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(MEDIA_HEADER_LEN + payload.byteLength);
    const view = new DataView(out.buffer);
    view.setUint8(0, MEDIA_KINDS[header.kind]);
    view.setUint8(
        1,
        (header.key ? MEDIA_FLAGS.key : 0) | (header.refine ? MEDIA_FLAGS.refine : 0) | (header.clip === true ? MEDIA_FLAGS.clip : 0),
    );
    view.setUint32(2, header.id >>> 0);
    view.setUint32(6, header.captureMs >>> 0);
    view.setUint16(10, header.stripeTop);
    view.setUint8(12, header.stripeIndex);
    view.setUint8(13, header.stripeCount);
    out.set(payload, MEDIA_HEADER_LEN);
    return out;
};
