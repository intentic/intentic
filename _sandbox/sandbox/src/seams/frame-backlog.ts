// The frames one /events connection has not taken yet, bounded. A tab frozen in the background keeps its socket open and
// reads nothing, and unbounded, every snapshot it misses is held for it until it wakes. Past the bound the backlog is
// dropped and `onCut` ends the connection: its reconnect's hello reconciles everything a dropped frame said.

// A reading consumer takes each frame as it lands, so a live one never nears either bound.
export const MAX_BACKLOG_FRAMES = 256;
// Milliseconds the oldest frame may wait: a consumer that has taken nothing for this long has stopped reading.
export const MAX_BACKLOG_WAIT_MS = 120_000;

export interface Framed<T> {
    readonly frame: T;
    // process.hrtime.bigint() at production, so a reader can say how long the frame sat.
    readonly at: bigint;
}

export interface FrameBacklog<T> {
    // Ignored once cut: nothing is held for a connection that is ending.
    readonly push: (frame: T) => void;
    // Frames handed over whole as the consumer arrives (a follower's replay of the facts so far), held ahead of
    // anything pushed. However many, they never count against the frame bound, since they are what the consumer came
    // for rather than what it fell behind on, and seeding never cuts. The wait bound still reads them: untaken once it
    // has passed, they cut the consumer at the next push, as a consumer that stopped reading.
    readonly seed: (frames: readonly T[]) => void;
    readonly shift: () => Framed<T> | undefined;
    readonly depth: () => number;
}

export const frameBacklog = <T>(
    onCut: (unsent: number) => void,
    { frames = MAX_BACKLOG_FRAMES, waitMs = MAX_BACKLOG_WAIT_MS, now = () => process.hrtime.bigint() } = {},
): FrameBacklog<T> => {
    const queued: Framed<T>[] = [];
    // How many seeded frames are still at the head of the queue, untaken.
    let seeded = 0;
    let cut = false;
    return {
        push: (frame) => {
            if (cut) {
                return;
            }
            const at = now();
            queued.push({ frame, at });
            const waitedMs = Number(at - (queued[0] as Framed<T>).at) / 1e6;
            if (queued.length - seeded <= frames && waitedMs <= waitMs) {
                return;
            }
            cut = true;
            const unsent = queued.length;
            queued.length = 0;
            seeded = 0;
            onCut(unsent);
        },
        seed: (replay) => {
            if (cut) {
                return;
            }
            const at = now();
            for (const frame of replay) {
                queued.push({ frame, at });
            }
            seeded += replay.length;
        },
        shift: () => {
            const next = queued.shift();
            if (next !== undefined && seeded > 0) {
                seeded -= 1;
            }
            return next;
        },
        depth: () => queued.length,
    };
};

// One subscriber's queue; a follower holds only what it has not yet read, so a stalled reader's backlog never reaches
// the others. A bounded one is cut past this backlog's bound, its reader ending with the error it was given so it
// re-attaches for a fresh head; the daemon's own readers are unbounded, reading as they are fed.
export class Mailbox<T> {
    private readonly queue: FrameBacklog<T>;
    private wake: (() => void) | undefined;
    private closed = false;
    private failure: Error | undefined;

    constructor(replay: readonly T[], bounded: { readonly failure: () => Error; readonly onCut: () => void } | undefined) {
        this.queue = frameBacklog<T>(
            () => {
                if (bounded !== undefined) {
                    this.cut(bounded.failure());
                    bounded.onCut();
                }
            },
            bounded === undefined ? { frames: Infinity, waitMs: Infinity } : {},
        );
        // Seeded, never pushed: a run's facts so far, replayed to every attach, run to hundreds on a long Codex or Gemini
        // turn (a context reading after each model step). Pushed, they passed the bound before the follower existed, and
        // nothing could follow that turn again.
        this.queue.seed(replay);
    }

    push(item: T): void {
        if (this.closed) {
            return;
        }
        this.queue.push(item);
        this.wake?.();
    }

    close(): void {
        this.closed = true;
        this.wake?.();
    }

    // Ends the reader with `error` as soon as it next reads; nothing queued is delivered after the cut.
    cut(error: Error): void {
        if (this.failure !== undefined) {
            return;
        }
        this.failure = error;
        this.closed = true;
        this.wake?.();
    }

    // Everything pushed, in order, until closed and drained, or until cut. `released` runs however the reader leaves,
    // including early exit, so the queue never leaks.
    async *drain(released: () => void): AsyncGenerator<T> {
        try {
            for (;;) {
                if (this.failure !== undefined) {
                    throw this.failure;
                }
                const next = this.queue.shift();
                if (next !== undefined) {
                    yield next.frame;
                    continue;
                }
                if (this.closed) {
                    return;
                }
                await new Promise<void>((resolve) => {
                    this.wake = resolve;
                });
                this.wake = undefined;
            }
        } finally {
            released();
        }
    }
}
