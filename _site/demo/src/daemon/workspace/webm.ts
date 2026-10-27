// A WebM file around VP8 frames: the few Matroska elements a player needs to play it and seek in it (a duration, one
// track, a cue per cluster), written here so the demo can ship a real recording without shipping its bytes.
// Element ids and layout are Matroska's (https://www.matroska.org/technical/elements.html).

export interface WebmFrame {
    readonly data: Uint8Array;
    // Milliseconds from the start.
    readonly at: number;
    readonly key: boolean;
}

const concat = (parts: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let at = 0;
    for (const part of parts) {
        out.set(part, at);
        at += part.length;
    }
    return out;
};

const idBytes = (id: number): Uint8Array => {
    const bytes: number[] = [];
    for (let rest = id; rest > 0; rest = Math.floor(rest / 256)) {
        bytes.unshift(rest % 256);
    }
    return Uint8Array.from(bytes);
};

// Every size is written in eight bytes, so an element's length never depends on what it holds.
const sizeBytes = (size: number): Uint8Array => {
    const bytes = new Uint8Array(8);
    bytes[0] = 0x01;
    let rest = size;
    for (let index = 7; index > 0; index -= 1) {
        bytes[index] = rest % 256;
        rest = Math.floor(rest / 256);
    }
    return bytes;
};

const element = (id: number, ...body: Uint8Array[]): Uint8Array => {
    const inner = concat(body);
    return concat([idBytes(id), sizeBytes(inner.length), inner]);
};

// An unsigned integer in `width` bytes, big-endian.
const uint = (id: number, value: number, width = 4): Uint8Array => {
    const bytes = new Uint8Array(width);
    let rest = value;
    for (let index = width - 1; index >= 0; index -= 1) {
        bytes[index] = rest % 256;
        rest = Math.floor(rest / 256);
    }
    return element(id, bytes);
};

const float = (id: number, value: number): Uint8Array => {
    const bytes = new Uint8Array(8);
    new DataView(bytes.buffer).setFloat64(0, value);
    return element(id, bytes);
};

const text = (id: number, value: string): Uint8Array => element(id, new TextEncoder().encode(value));

const header = (): Uint8Array =>
    element(0x1a45dfa3, uint(0x4286, 1), uint(0x42f7, 1), uint(0x42f2, 4), uint(0x42f3, 8), text(0x4282, `webm`), uint(0x4287, 2), uint(0x4285, 2));

// One cluster per key frame: a cluster starts where a seek can land.
const clustersOf = (frames: readonly WebmFrame[]): { readonly at: number; readonly frames: WebmFrame[] }[] => {
    const clusters: { at: number; frames: WebmFrame[] }[] = [];
    for (const frame of frames) {
        const last = clusters.at(-1);
        if (frame.key || last === undefined) {
            clusters.push({ at: frame.at, frames: [frame] });
        } else {
            last.frames.push(frame);
        }
    }
    return clusters;
};

const simpleBlock = (frame: WebmFrame, clusterAt: number): Uint8Array => {
    const head = new Uint8Array(4);
    // Track 1 as a one-byte vint, the time relative to the cluster as a signed 16-bit, then the key flag.
    head[0] = 0x81;
    new DataView(head.buffer).setInt16(1, Math.round(frame.at - clusterAt));
    head[3] = frame.key ? 0x80 : 0;
    return element(0xa3, head, frame.data);
};

/** The frames as a seekable WebM file, `durationMs` long. */
export const webmOf = (frames: readonly WebmFrame[], size: { readonly width: number; readonly height: number }, durationMs: number): Uint8Array<ArrayBuffer> => {
    const info = element(0x1549a966, uint(0x2ad7b1, 1_000_000), float(0x4489, durationMs), text(0x4d80, `acme-shop`), text(0x5741, `acme-shop`));
    const video = element(0xe0, uint(0xb0, size.width, 2), uint(0xba, size.height, 2));
    const tracks = element(0x1654ae6b, element(0xae, uint(0xd7, 1, 1), uint(0x73c5, 1, 1), uint(0x83, 1, 1), text(0x86, `V_VP8`), video));
    const clusters = clustersOf(frames).map((cluster) => ({
        at: cluster.at,
        bytes: element(0x1f43b675, uint(0xe7, Math.round(cluster.at), 4), ...cluster.frames.map((frame) => simpleBlock(frame, cluster.at))),
    }));
    // Cues go before the clusters, so a player finds them without reading to the end; every width in them is fixed,
    // so their length is known before the positions they hold are.
    const cuesFor = (offsets: readonly number[]): Uint8Array =>
        element(
            0x1c53bb6b,
            ...clusters.map((cluster, index) =>
                element(0xbb, uint(0xb3, Math.round(cluster.at), 4), element(0xb7, uint(0xf7, 1, 1), uint(0xf1, offsets[index] ?? 0, 8))),
            ),
        );
    const before = info.length + tracks.length + cuesFor([]).length;
    const offsets: number[] = [];
    let at = before;
    for (const cluster of clusters) {
        offsets.push(at);
        at += cluster.bytes.length;
    }
    const segment = element(0x18538067, info, tracks, cuesFor(offsets), ...clusters.map((cluster) => cluster.bytes));
    return concat([header(), segment]);
};
