// WHAT THE DECODE WORKER OWES CASTD FOR EVERY FRAME, AND WHAT IT KNOWS ABOUT HOW THE PICTURE IS DOING. castd steers its
// bitrate on acks (media.rs, rate.rs): each frame id is acked once, after every stripe of it that arrived has decoded,
// with the time from its first stripe's arrival to its last stripe's output. A stripe the decoder never painted (a
// decode error, a delta dropped while waiting for a keyframe) still settles its frame, acked without a decode time, so
// castd's queue of frames in flight drains and the frame counts as dropped here.

/** One `ack` for castd: the frame's id, and its decode time when anything of it decoded. */
export interface Ack {
    readonly id: number;
    readonly decodeMs?: number;
}

interface Pending {
    readonly arrivedAt: number;
    // Stripe indices that arrived and have not decoded, failed or been dropped yet.
    readonly waiting: Set<number>;
    decoded: boolean;
}

// Ids are u32 and rise by one per frame; a wrap is compared the way castd compares them (hub.rs wrapping_le).
const notAfter = (left: number, right: number): boolean => (right - left) >>> 0 < 0x8000_0000;

// A frame still pending this long has lost its outputs (a decoder reset under it): it is settled as dropped rather
// than held forever.
const STALE_MS = 2000;

export interface AckBook {
    // A stripe of frame `id` arrived.
    readonly arrived: (id: number, stripe: number, at: number) => void;
    // A stripe of frame `id` came out of its decoder (`decoded`) or never will (`false`); the ack it completes, if any.
    readonly settled: (id: number, stripe: number, at: number, decoded: boolean) => Ack | undefined;
    // Every frame still waiting on `stripe` will not get it (that stripe's decoder was reset); the acks that completes.
    readonly lostStripe: (stripe: number, at: number) => readonly Ack[];
    // Frames waiting longer than STALE_MS, settled as dropped.
    readonly sweep: (at: number) => readonly Ack[];
    // Frames that settled with nothing decoded, since the book began.
    readonly dropped: () => number;
    // Whether every frame up to `id` that arrived has settled: none of them is still in a decoder.
    readonly settledThrough: (id: number) => boolean;
    // A fresh stream (`hello`): nothing pending carries over, and ids may start again.
    readonly reset: () => void;
}

export const ackBook = (): AckBook => {
    const pending = new Map<number, Pending>();
    let lastAcked: number | undefined;
    let dropped = 0;

    const complete = (id: number, frame: Pending, at: number): Ack | undefined => {
        pending.delete(id);
        if (!frame.decoded) {
            dropped += 1;
        }
        // A stripe that arrived after its frame was acked (decoded faster than its sibling arrived) is not acked twice.
        if (lastAcked !== undefined && notAfter(id, lastAcked)) {
            return undefined;
        }
        lastAcked = id;
        return frame.decoded ? { id, decodeMs: Math.max(0, at - frame.arrivedAt) } : { id };
    };

    const settle = (id: number, stripe: number, at: number, decoded: boolean): Ack | undefined => {
        const frame = pending.get(id);
        if (frame === undefined || !frame.waiting.delete(stripe)) {
            return undefined;
        }
        frame.decoded ||= decoded;
        return frame.waiting.size === 0 ? complete(id, frame, at) : undefined;
    };

    const settleAll = (ids: readonly number[], stripeOf: (frame: Pending) => readonly number[], at: number): Ack[] =>
        ids.flatMap((id) => {
            const frame = pending.get(id);
            if (frame === undefined) {
                return [];
            }
            let ack: Ack | undefined;
            for (const stripe of stripeOf(frame)) {
                ack = settle(id, stripe, at, false) ?? ack;
            }
            return ack === undefined ? [] : [ack];
        });

    return {
        arrived: (id, stripe, at) => {
            const frame = pending.get(id);
            if (frame === undefined) {
                pending.set(id, { arrivedAt: at, waiting: new Set([stripe]), decoded: false });
            } else {
                frame.waiting.add(stripe);
            }
        },
        settled: settle,
        lostStripe: (stripe, at) =>
            settleAll(
                [...pending].filter(([, frame]) => frame.waiting.has(stripe)).map(([id]) => id),
                () => [stripe],
                at,
            ),
        sweep: (at) =>
            settleAll(
                [...pending].filter(([, frame]) => at - frame.arrivedAt > STALE_MS).map(([id]) => id),
                (frame) => [...frame.waiting],
                at,
            ),
        dropped: () => dropped,
        settledThrough: (id) => ![...pending.keys()].some((waiting) => notAfter(waiting, id)),
        reset: () => {
            pending.clear();
            lastAcked = undefined;
        },
    };
};

/**
 * Work that waits for the frames before it: each piece runs once every frame up to its id has settled
 * (`settledThrough`), in the order the pieces came, a piece waiting holding back every piece after it. castd's exact
 * copies are drawn this way, after the frames sent before them, since a decoder hands its frames back later than they
 * arrive.
 */
export interface FrameQueue {
    readonly after: (id: number, run: () => void) => void;
    // Frames settled: whatever no longer waits runs.
    readonly drain: () => void;
    // A fresh stream: what waits is dropped, never run.
    readonly drop: () => void;
}

export const frameQueue = (settledThrough: (id: number) => boolean): FrameQueue => {
    const waiting: { readonly id: number; readonly run: () => void }[] = [];
    const drain = (): void => {
        while (waiting.length > 0 && settledThrough(waiting[0]!.id)) {
            waiting.shift()!.run();
        }
    };
    return {
        after: (id, run) => {
            waiting.push({ id, run });
            drain();
        },
        drain,
        drop: () => {
            waiting.length = 0;
        },
    };
};

/** What the stats overlay shows; every time in ms. Undefined fields have no sample yet. */
export interface MediaStats {
    // Frames decoded in the last second: one per frame acked with a decode time, however many stripes it was cut into.
    readonly fps: number;
    // Median and 95th percentile of the last second's decode times (first stripe in → last stripe out).
    readonly decodeMs?: number;
    // Capture → drawn, median and 95th percentile over the last two seconds.
    readonly ageMs?: number;
    readonly ageP95Ms?: number;
    // The editor's own ping round trip.
    readonly rttMs?: number;
    // castd's word, from its last `stats`.
    readonly targetKbps?: number;
    readonly queueMs?: number;
    readonly sentFps?: number;
    // What arrived in the last second.
    readonly kbps: number;
    readonly dropped: number;
    readonly width: number;
    readonly height: number;
    readonly scale: number;
    readonly stripes: number;
    // Sound held in the jitter buffer, and its target, while sound plays.
    readonly audioMs?: number;
    readonly audioTargetMs?: number;
}

const percentile = (values: readonly number[], share: number): number | undefined => {
    if (values.length === 0) {
        return undefined;
    }
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.min(sorted.length - 1, Math.floor(share * sorted.length))];
};

interface Sample {
    readonly at: number;
    readonly value: number;
}

// Samples kept for `windowMs`, oldest dropped as new ones come.
const recent = (windowMs: number) => {
    const samples: Sample[] = [];
    const trim = (at: number): void => {
        while (samples.length > 0 && at - samples[0]!.at > windowMs) {
            samples.shift();
        }
    };
    return {
        add: (at: number, value: number): void => {
            samples.push({ at, value });
            trim(at);
        },
        values: (at: number): number[] => {
            trim(at);
            return samples.map((sample) => sample.value);
        },
        clear: (): void => {
            samples.length = 0;
        },
    };
};

export interface StatsBook {
    // A stripe was drawn; its age, when known. Called per stripe, so it counts no frames.
    readonly drawn: (at: number, ageMs: number | undefined) => void;
    // A whole frame decoded, in this long: what the frames a second count.
    readonly decoded: (at: number, decodeMs: number) => void;
    readonly bytes: (at: number, count: number) => void;
    readonly snapshot: (at: number, rest: Omit<MediaStats, `fps` | `decodeMs` | `ageMs` | `ageP95Ms` | `kbps`>) => MediaStats;
    readonly reset: () => void;
}

export const statsBook = (): StatsBook => {
    const decodes = recent(1000);
    const ages = recent(2000);
    const received = recent(1000);
    return {
        drawn: (at, ageMs) => {
            if (ageMs !== undefined) {
                ages.add(at, ageMs);
            }
        },
        decoded: (at, decodeMs) => decodes.add(at, decodeMs),
        bytes: (at, count) => received.add(at, count),
        snapshot: (at, rest) => {
            const age = ages.values(at);
            const decoded = decodes.values(at);
            const decode = percentile(decoded, 0.5);
            const ageMs = percentile(age, 0.5);
            const ageP95Ms = percentile(age, 0.95);
            return {
                ...rest,
                fps: decoded.length,
                decodeMs: decode,
                ageMs,
                ageP95Ms,
                kbps: (received.values(at).reduce((sum, count) => sum + count, 0) * 8) / 1000,
            };
        },
        reset: () => {
            decodes.clear();
            ages.clear();
            received.clear();
        },
    };
};

/**
 * When castd's capture clock started, on this clock: its `hello` left castd at the epoch the capture times count from,
 * and arrived here `oneWayMs` later, unless it queued behind a large picture still in flight, which makes it late and
 * every age read off it too young. A picture cannot arrive before it was captured, so every arrival bounds the epoch
 * too: the earlier of the two is the better guess, and an age is never read as negative.
 */
export const captureEpoch = (helloAt: number, oneWayMs: number, earliestArrivalLessCapture: number): number =>
    Math.min(helloAt - oneWayMs, earliestArrivalLessCapture);

/** How old a frame is when drawn, in ms: from its capture (`captureMs` after castd's capture epoch) to now. */
export const frameAge = (drawnAt: number, epoch: number, captureMs: number): number => drawnAt - epoch - captureMs;

/** castd's capture clock as this side reads it: started by each `hello`, bounded by each picture's arrival. */
export const captureClock = (now: () => number) => {
    let helloAt = 0;
    let arrivedLessCapture = Number.POSITIVE_INFINITY;
    return {
        hello: (): void => {
            helloAt = now();
            arrivedLessCapture = Number.POSITIVE_INFINITY;
        },
        arrived: (captureMs: number): void => {
            arrivedLessCapture = Math.min(arrivedLessCapture, now() - captureMs);
        },
        // How old a picture captured at `captureMs` is now.
        age: (captureMs: number, oneWayMs: number): number => frameAge(now(), captureEpoch(helloAt, oneWayMs, arrivedLessCapture), captureMs),
        // castd's clock now, as near as the hello says.
        castdNow: (): number => now() - helloAt,
    };
};
