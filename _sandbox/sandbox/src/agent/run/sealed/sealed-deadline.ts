import { whenAborted } from "@intentic/base/async";

// A sealed request's own deadline beside its caller's cancel, both ending the call through `stop` until it is released.
// A helper is waited on by something with a person behind it (a commit box, a card), so a model that will not answer is
// stepped over after seconds rather than ridden out the way a turn rides out a slow provider.

export interface SealedDeadline {
    // Whether the clock, rather than the caller, is what ended the call.
    readonly expired: () => boolean;
    // The call came back with nothing: said as the deadline when that is what ended it.
    readonly unanswered: () => Error;
    // A failure once the deadline passed is the deadline's, whatever the torn-down call threw instead; before, it is
    // handed back as it was thrown.
    readonly claim: <E>(error: E) => E | Error;
    readonly release: () => void;
}

// `namedMs` is the figure the sentence gives, which is the deadline itself unless a caller has always named another.
// A caller that already cancelled stops the call at once: an abort listener added late never fires.
export const sealedDeadline = (caller: AbortSignal, ms: number, stop: () => void, namedMs = ms): SealedDeadline => {
    let expired = false;
    const unsubscribe = whenAborted(caller, stop);
    const timer = setTimeout(() => {
        expired = true;
        stop();
    }, ms);
    const overdue = (cause?: unknown): Error =>
        new Error(`the model did not answer within ${namedMs / 1_000}s`, cause === undefined ? undefined : { cause });
    return {
        expired: () => expired,
        unanswered: () => (expired ? overdue() : new Error("the model did not answer")),
        claim: (error) => (expired ? overdue(error) : error),
        release: () => {
            clearTimeout(timer);
            unsubscribe();
        },
    };
};
