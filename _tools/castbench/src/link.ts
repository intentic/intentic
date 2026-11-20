// The links a run is measured over, and the arithmetic of the bottleneck the shaping proxy (shaper.ts) puts between the
// pipeline and its viewer. Apart from the sockets so it can be tested by value.

export interface Link {
    // How the link is named on the command line and in a run's results: `direct`, or `<rate>mbit-<rtt>ms`.
    readonly name: string;
    // The rate from the pipeline to the viewer, in Mbit/s; null for no cap.
    readonly mbps: number | null;
    // Added round trip, half on each direction.
    readonly rttMs: number;
}

export const DIRECT: Link = { name: "direct", mbps: null, rttMs: 0 };

// The two links the budgets name: a decent home connection, and a poor one.
export const STANDARD_LINKS: readonly Link[] = [DIRECT, { name: "10mbit-40ms", mbps: 10, rttMs: 40 }, { name: "5mbit-60ms", mbps: 5, rttMs: 60 }];

export const parseLink = (name: string): Link => {
    if (name === DIRECT.name) {
        return DIRECT;
    }
    const match = /^(\d+(?:\.\d+)?)mbit-(\d+(?:\.\d+)?)ms$/u.exec(name);
    if (match === null) {
        throw new Error(`a link is "direct" or "<rate>mbit-<rtt>ms" (e.g. 10mbit-40ms), not "${name}"`);
    }
    const mbps = Number(match[1]);
    if (!(mbps > 0)) {
        throw new Error(`a link's rate must be above zero: "${name}"`);
    }
    return { name, mbps, rttMs: Number(match[2]) };
};

// How long the bottleneck takes to put `bytes` on the wire at `mbps`, in ms. Mbit/s is 1000 bits per ms.
export const serializeMs = (bytes: number, mbps: number | null): number => (mbps === null ? 0 : (bytes * 8) / (mbps * 1000));

// How many bytes `ms` of the link's rate is: the size of a queue given in time.
export const bytesInMs = (ms: number, mbps: number | null): number => (mbps === null ? Infinity : (ms * mbps * 1000) / 8);

export interface Bottleneck {
    // When `bytes` handed to the link at `now` (ms, monotonic) arrive at the far end: queued behind what the link still
    // holds, serialized at the rate, then delayed by the one-way delay.
    readonly arrival: (bytes: number, now: number) => number;
    // Bytes handed over and not yet on the wire at `now`: the queue a bounded proxy holds its reads against.
    readonly backlogBytes: (now: number) => number;
    // How long from `now` until the backlog is down to `bytes`.
    readonly msUntilBacklog: (bytes: number, now: number) => number;
}

// One direction of a link: a FIFO serializer at `mbps` followed by a fixed `delayMs`. The arithmetic voxl's shaper.py
// uses, with the backlog made readable so the proxy can push back instead of holding everything it is sent.
export const bottleneck = (mbps: number | null, delayMs: number): Bottleneck => {
    // When the serializer finishes what it already holds.
    let freeAt = Number.NEGATIVE_INFINITY;
    const backlogMs = (now: number): number => Math.max(0, freeAt - now);
    return {
        arrival: (bytes, now) => {
            freeAt = Math.max(freeAt, now) + serializeMs(bytes, mbps);
            return freeAt + delayMs;
        },
        backlogBytes: (now) => (mbps === null ? 0 : (backlogMs(now) * mbps * 1000) / 8),
        msUntilBacklog: (bytes, now) => (mbps === null ? 0 : Math.max(0, backlogMs(now) - serializeMs(bytes, mbps))),
    };
};

// Cuts `length` bytes into slices of at most `size`, as [start, end) pairs: a frame handed over in one read is then
// delivered as the link would, a slice at a time, rather than all at once when its last byte is due.
export const slices = (length: number, size: number): (readonly [number, number])[] => {
    const cut: (readonly [number, number])[] = [];
    for (let start = 0; start < length; start += size) {
        cut.push([start, Math.min(length, start + size)]);
    }
    return cut;
};
