import { unlessAborted, whenAborted } from "@intentic/base/async";

// How long a stopped turn's runtime gets to wind down on its own before the turn stops waiting on it. A runtime is told
// of a stop through its signal, and most end within a second; one wedged on a read that never answers (a server the
// kernel killed, an event stream retrying for ever) would otherwise hold the conversation "Stopping…" for good, and with
// it every queued message and the archive that waits for the turn to end.
export const STOP_GRACE_MS = 15_000;

// What a read answers once the grace is over, in place of the frame it was waiting for.
const ABANDONED: unique symbol = Symbol("abandoned");

// A runtime's frames, ended a grace period after `signal` aborts if the runtime has not ended them itself. The abandoned
// stream is asked to return without being awaited, since a wedged one may never answer that either; `abandoned` hears
// of it once, for the log.
export async function* endedAfterStop<T>(
    frames: AsyncIterable<T>,
    signal: AbortSignal | undefined,
    abandoned: () => void,
    graceMs: number = STOP_GRACE_MS,
): AsyncGenerator<T> {
    const iterator = frames[Symbol.asyncIterator]();
    // Aborts once the grace after a stop runs out. Each read waits on this signal rather than on a promise of the grace:
    // one promise raced by every read of a turn that is never stopped keeps every frame it raced until the turn ends.
    const graceOver = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = whenAborted(signal, () => {
        timer = setTimeout(() => graceOver.abort(), graceMs);
        timer.unref?.();
    });
    let finished = false;
    try {
        for (;;) {
            const next = iterator.next();
            const result = await unlessAborted(next, graceOver.signal, ABANDONED);
            if (result === ABANDONED) {
                // allow(silent-catch): the read lost to the grace; the stream is being walked away from
                next.catch(() => {});
                // allow(silent-catch): a wedged stream may refuse to return as well; nothing is waiting on it
                void iterator.return?.()?.catch(() => {});
                finished = true;
                abandoned();
                return;
            }
            if (result.done === true) {
                finished = true;
                return;
            }
            yield result.value;
        }
    } finally {
        clearTimeout(timer);
        unsubscribe();
        // The consumer left early (its own return or throw): pass that on, as a for-await would.
        if (!finished) {
            await iterator.return?.();
        }
    }
}
