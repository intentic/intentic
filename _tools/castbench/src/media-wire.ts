import { MEDIA_FLAGS, MEDIA_HEADER_LEN, MEDIA_KINDS } from "@intentic/sandbox-contract/browser-wire";

// The fixed header of a binary message on a media socket, as browser-wire's MEDIA_HEADER_LEN states it, read and
// written here for the castd adapter, the decoder page and the stub castd alike. Big-endian throughout.

export interface MediaHeader {
    readonly kind: number;
    readonly key: boolean;
    readonly refine: boolean;
    // The frame's id, rising; what an `ack` names.
    readonly id: number;
    // When its content was captured, in ms since the stream's `hello`.
    readonly capturedMs: number;
    // The stripe's top row in picture pixels, its index, and how many stripes the picture is cut into (1 when whole).
    readonly stripeTop: number;
    readonly stripeIndex: number;
    readonly stripeCount: number;
}

export const isVideo = (header: MediaHeader): boolean => header.kind === MEDIA_KINDS.video;

// Undefined for a message too short to hold the header.
export const parseMediaHeader = (bytes: Uint8Array): MediaHeader | undefined => {
    if (bytes.byteLength < MEDIA_HEADER_LEN) {
        return undefined;
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, MEDIA_HEADER_LEN);
    const flags = view.getUint8(1);
    return {
        kind: view.getUint8(0),
        key: (flags & MEDIA_FLAGS.key) !== 0,
        refine: (flags & MEDIA_FLAGS.refine) !== 0,
        id: view.getUint32(2),
        capturedMs: view.getUint32(6),
        stripeTop: view.getUint16(10),
        stripeIndex: view.getUint8(12),
        stripeCount: view.getUint8(13),
    };
};

// A whole message: the header, then the payload (one Annex B access unit for video).
export const encodeMediaMessage = (header: MediaHeader, payload: Uint8Array): Uint8Array<ArrayBuffer> => {
    const message = new Uint8Array(MEDIA_HEADER_LEN + payload.byteLength);
    const view = new DataView(message.buffer);
    view.setUint8(0, header.kind);
    view.setUint8(1, (header.key ? MEDIA_FLAGS.key : 0) | (header.refine ? MEDIA_FLAGS.refine : 0));
    view.setUint32(2, header.id >>> 0);
    view.setUint32(6, header.capturedMs >>> 0);
    view.setUint16(10, header.stripeTop);
    view.setUint8(12, header.stripeIndex);
    view.setUint8(13, header.stripeCount);
    message.set(payload, MEDIA_HEADER_LEN);
    return message;
};

export const mediaPayload = (bytes: Uint8Array): Uint8Array => bytes.subarray(MEDIA_HEADER_LEN);

// castd's video on a peer connection's `media` channel, joined back: a message longer than browser-wire's
// RTC_MESSAGE_MAX arrives as chunks that each carry its header, byte 14 the chunk's index and byte 15 their count. Each
// message in, the whole one out once its last chunk is in; a chunk out of turn drops what was gathered.
export const chunkJoiner = (): ((message: Uint8Array) => Uint8Array | undefined) => {
    let gathering: { id: number; count: number; next: number; parts: Uint8Array[] } | undefined;
    return (message) => {
        const header = parseMediaHeader(message);
        const index = message[14] ?? 0;
        const count = message[15] ?? 0;
        if (header === undefined || count <= 1) {
            gathering = undefined;
            return header === undefined ? undefined : message;
        }
        if (gathering?.id !== header.id || gathering.count !== count || gathering.next !== index) {
            gathering = index === 0 ? { id: header.id, count, next: 0, parts: [message.subarray(0, MEDIA_HEADER_LEN)] } : undefined;
        }
        if (gathering === undefined) {
            return undefined;
        }
        gathering.parts.push(message.subarray(MEDIA_HEADER_LEN));
        gathering.next = index + 1;
        if (gathering.next < count) {
            return undefined;
        }
        const whole = new Uint8Array(gathering.parts.reduce((size, part) => size + part.byteLength, 0));
        let at = 0;
        for (const part of gathering.parts) {
            whole.set(part, at);
            at += part.byteLength;
        }
        whole[14] = 0;
        whole[15] = 0;
        gathering = undefined;
        return whole;
    };
};
