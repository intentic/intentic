import { MEDIA_HEADER_LEN, RTC_MESSAGE_MAX } from "@intentic/sandbox-contract/browser-wire";

// THE TWO WAYS A MESSAGE IS CUT TO FIT A DATACHANNEL (browser-wire's RTC_MESSAGE_MAX). castd cuts a long video message
// into chunks that each carry its header, byte 14 the chunk's index and byte 15 their count, and the page joins them
// back before the decoder sees anything, so the decoder reads exactly what the socket would have carried. The viewer
// cuts a long JSON message (a paste) into binary chunks of one byte of index, one of count and the next slice of its
// UTF-8, which castd joins in order on the ordered `input` channel, so a paste stays in order with the keys around it.

const INDEX = 14;
const COUNT = 15;

/** What to send on `input` for one JSON message: the text itself when it fits, else its chunks. */
export const inputMessages = (text: string): readonly (string | Uint8Array<ArrayBuffer>)[] => {
    const bytes = new TextEncoder().encode(text);
    if (bytes.byteLength <= RTC_MESSAGE_MAX) {
        return [text];
    }
    const slice = RTC_MESSAGE_MAX - 2;
    const count = Math.ceil(bytes.byteLength / slice);
    if (count > 255) {
        return [];
    }
    return Array.from({ length: count }, (_, index) => {
        const part = bytes.subarray(index * slice, (index + 1) * slice);
        const chunk = new Uint8Array(2 + part.byteLength);
        chunk[0] = index;
        chunk[1] = count;
        chunk.set(part, 2);
        return chunk;
    });
};

/**
 * Joins castd's chunked video messages: each binary message on `media` in, the whole message out once its last chunk
 * is in (at once for one that was never cut). A chunk out of turn drops what was gathered: the channel is ordered and
 * reliable, so it would be castd's bug, and the next keyframe starts the picture again.
 */
export const mediaJoiner = (): ((message: ArrayBuffer) => ArrayBuffer | undefined) => {
    let gathering: { readonly id: number; readonly count: number; next: number; parts: Uint8Array[]; size: number } | undefined;
    return (message) => {
        const bytes = new Uint8Array(message);
        if (bytes.byteLength < MEDIA_HEADER_LEN) {
            return undefined;
        }
        const index = bytes[INDEX] ?? 0;
        const count = bytes[COUNT] ?? 0;
        if (count <= 1) {
            gathering = undefined;
            return message;
        }
        const id = new DataView(message).getUint32(2);
        if (gathering === undefined || gathering.id !== id || gathering.count !== count || gathering.next !== index) {
            gathering = index === 0 ? { id, count, next: 0, parts: [bytes.subarray(0, MEDIA_HEADER_LEN)], size: MEDIA_HEADER_LEN } : undefined;
        }
        if (gathering === undefined) {
            return undefined;
        }
        const part = bytes.subarray(MEDIA_HEADER_LEN);
        gathering.parts.push(part);
        gathering.size += part.byteLength;
        gathering.next = index + 1;
        if (gathering.next < count) {
            return undefined;
        }
        const whole = new Uint8Array(gathering.size);
        let at = 0;
        for (const piece of gathering.parts) {
            whole.set(piece, at);
            at += piece.byteLength;
        }
        // A whole message's reserved bytes are zero, as on the socket.
        whole[INDEX] = 0;
        whole[COUNT] = 0;
        gathering = undefined;
        return whole.buffer;
    };
};
