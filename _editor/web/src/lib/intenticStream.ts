import type { IntenticLine } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/client";
import { z } from "zod";
import { acquireStreamSlot } from "./streamBudget";

// Reads a daemon stream of IntenticLine frames (`intentic.run` and its kin) as they arrive; a failure the daemon reports
// mid-stream becomes one last kind:"error" line, so callers stop on it rather than on a throw. One connection-pool
// permit per read, since these can hold a socket for minutes; released in the generator's `finally`, even on early break.
export async function* readIntenticLines(frames: AsyncIterable<IntenticLine>): AsyncGenerator<IntenticLine> {
    const slot = await acquireStreamSlot(`attach`);
    try {
        for await (const line of frames) {
            if (typeof line === `object` && line !== null) {
                yield line;
            }
        }
    } catch (error) {
        if (!(error instanceof ORPCError)) {
            throw error;
        }
        yield { kind: `error`, message: error.message };
    } finally {
        slot?.();
    }
}

// An error line's own words, when it sent any.
const SaidSchema = z.looseObject({ message: z.string().min(1) });

/** The command's own failure: an error line it sent, worded by its `message` or, without one, by the caller's fallback. */
export class StreamFailedError extends Error {
    constructor(
        readonly line: IntenticLine,
        fallback: string,
    ) {
        super(SaidSchema.safeParse(line).data?.message ?? fallback);
    }
}

/** A stream that ended without an error line and without the result line every command closes on. */
export class StreamEndedError extends Error {}

export interface UntilResultOptions {
    /** Words for an error line that carries no message, in the reader's language (built only when needed). */
    readonly failed: () => string;
    /** Words for a stream that ended with no result line; the `failed` words when absent. */
    readonly ended?: (() => string) | undefined;
    /** Every line as it arrives, the error and result lines included. */
    readonly onLine?: ((line: IntenticLine) => void) | undefined;
    /** Stops reading and rejects with the signal's reason. Give the call that opened the stream the same signal, so the
     *  request itself is cancelled too: this can only close the stream between lines. */
    readonly signal?: AbortSignal | undefined;
}

/**
 * Consumes a command stream to its end and returns its result line (the last one, when it sent several). Throws
 * `StreamFailedError` on the FIRST error line, without reading further; `StreamEndedError` when the stream ends with no
 * result line; the signal's reason once it aborts; and whatever the transport threw, as it threw it.
 */
export async function untilResult(frames: AsyncIterable<IntenticLine>, options: UntilResultOptions): Promise<IntenticLine> {
    const { signal, onLine } = options;
    signal?.throwIfAborted();
    const lines = readIntenticLines(frames);
    let detach: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
        if (signal === undefined) {
            return;
        }
        const onAbort = (): void => reject(signal.reason ?? new DOMException(`The stream was aborted.`, `AbortError`));
        signal.addEventListener(`abort`, onAbort, { once: true });
        detach = () => signal.removeEventListener(`abort`, onAbort);
    });
    // allow(silent-catch): raced on every pull, which observes it; this only keeps an abort after settling from reading as unhandled.
    aborted.catch(() => undefined);
    let result: IntenticLine | undefined;
    try {
        for (;;) {
            const next = await Promise.race([lines.next(), aborted]);
            if (next.done === true) {
                break;
            }
            const line = next.value;
            onLine?.(line);
            if (line.kind === `error`) {
                throw new StreamFailedError(line, options.failed());
            }
            if (line.kind === `result`) {
                result = line;
            }
        }
    } finally {
        detach?.();
        // Closes the stream (and frees its pool permit) when this stops before its end. Not awaited: after an abort the
        // pending pull holds it until the cancelled request lets go.
        // allow(silent-catch): the outcome is already decided; a stream that fails while closing has nothing left to say.
        void lines.return(undefined).catch(() => undefined);
    }
    if (result === undefined) {
        throw new StreamEndedError((options.ended ?? options.failed)());
    }
    return result;
}
