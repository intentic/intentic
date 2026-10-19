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
    readonly shift: () => Framed<T> | undefined;
    readonly depth: () => number;
}

export const frameBacklog = <T>(
    onCut: (unsent: number) => void,
    { frames = MAX_BACKLOG_FRAMES, waitMs = MAX_BACKLOG_WAIT_MS, now = () => process.hrtime.bigint() } = {},
): FrameBacklog<T> => {
    const queued: Framed<T>[] = [];
    let cut = false;
    return {
        push: (frame) => {
            if (cut) {
                return;
            }
            const at = now();
            queued.push({ frame, at });
            const waitedMs = Number(at - (queued[0] as Framed<T>).at) / 1e6;
            if (queued.length <= frames && waitedMs <= waitMs) {
                return;
            }
            cut = true;
            const unsent = queued.length;
            queued.length = 0;
            onCut(unsent);
        },
        shift: () => queued.shift(),
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
        for (const item of replay) {
            this.queue.push(item);
        }
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
