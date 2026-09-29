// How long a stopped turn's runtime gets to wind down on its own before the turn stops waiting on it. A runtime is told
// of a stop through its signal, and most end within a second; one wedged on a read that never answers (a server the
// kernel killed, an event stream retrying for ever) would otherwise hold the conversation "Stopping…" for good, and with
// it every queued message and the archive that waits for the turn to end.
export const STOP_GRACE_MS = 15_000;

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
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const graceOver = new Promise<"abandon">((resolve) => {
        const arm = (): void => {
            timer = setTimeout(() => resolve("abandon"), graceMs);
            timer.unref?.();
        };
        if (signal === undefined) {
            return;
        }
        if (signal.aborted) {
            arm();
            return;
        }
        onAbort = arm;
        signal.addEventListener("abort", arm, { once: true });
    });
    let finished = false;
    try {
        for (;;) {
            const next = iterator.next();
            const result = await Promise.race([next, graceOver]);
            if (result === "abandon") {
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
        if (onAbort !== undefined) {
            signal?.removeEventListener("abort", onAbort);
        }
        // The consumer left early (its own return or throw): pass that on, as a for-await would.
        if (!finished) {
            await iterator.return?.();
        }
    }
}
