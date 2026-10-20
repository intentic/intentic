import type { LinkAnswerOf, LinkTarget } from "../sandboxes/link-client.js";
import type { LinkWire } from "./linked-children.js";

// How a follower or a re-ask waits after the far sandbox did not answer, and what cuts that wait short (2026-10-20). A
// link is plain HTTP with no connection to watch, so the one sign the far side is back is a call on the same link being
// answered: another task's status, a `links` hello, a message. That wakes every wait on the link at once, so a recovery
// is seen on the next answer rather than after a backoff grown to a minute. The timed backoff stays as the fallback for a
// link nothing else is calling.

export interface LinkBackoff {
    // A call on this link was answered.
    readonly answered: (linkId: string) => void;
    // Waits `ms`, or until a call on the link is answered ("woken"), or the signal aborts.
    readonly wait: (linkId: string, ms: number, signal?: AbortSignal) => Promise<"woken" | "elapsed">;
}

/** Waits out one step, and answers the next: back to `first` when the link answered meanwhile, else doubled up to `max`. */
export const nextRetry = async (
    backoff: Pick<LinkBackoff, "wait">,
    linkId: string,
    step: { readonly ms: number; readonly first: number; readonly max: number },
    signal?: AbortSignal,
): Promise<number> => ((await backoff.wait(linkId, step.ms, signal)) === "woken" ? step.first : Math.min(step.ms * 2, step.max));

export const createLinkBackoff = (): LinkBackoff => {
    const waiting = new Map<string, Set<() => void>>();
    return {
        answered: (linkId) => {
            // oxlint-disable-next-line unicorn/no-useless-spread -- The spread snapshots the waits, each of which removes itself.
            for (const wake of [...(waiting.get(linkId) ?? [])]) {
                wake();
            }
        },
        wait: (linkId, ms, signal) =>
            new Promise((resolve) => {
                if (signal?.aborted === true) {
                    resolve("elapsed");
                    return;
                }
                const held = waiting.get(linkId) ?? new Set<() => void>();
                waiting.set(linkId, held);
                const finish = (how: "woken" | "elapsed"): void => {
                    clearTimeout(timer);
                    signal?.removeEventListener("abort", aborted);
                    held.delete(woken);
                    if (held.size === 0) {
                        waiting.delete(linkId);
                    }
                    resolve(how);
                };
                const woken = (): void => finish("woken");
                const aborted = (): void => finish("elapsed");
                held.add(woken);
                const timer = setTimeout(aborted, ms);
                timer.unref();
                signal?.addEventListener("abort", aborted, { once: true });
            }),
    };
};

// Reports an answered call to the backoff under its link, so waits on that link end (link-backoff.ts).
const reportingTo =
    (backoff: Pick<LinkBackoff, "answered">) =>
    async <T>(target: LinkTarget, answer: Promise<LinkAnswerOf<T>>): Promise<LinkAnswerOf<T>> => {
        const answered = await answer;
        if (answered.ok) {
            backoff.answered(target.id);
        }
        return answered;
    };

// The wire with every answered call reported, whichever task or listing made it.
export const answeringWire = (wire: LinkWire, backoff: Pick<LinkBackoff, "answered">): LinkWire => {
    const report = reportingTo(backoff);
    return {
        hello: async (target, signal) => await report(target, wire.hello(target, signal)),
        ask: async (target, task) => await report(target, wire.ask(target, task)),
        status: async (target, id, hold, signal) => await report(target, wire.status(target, id, hold, signal)),
        message: async (target, id, message) => await report(target, wire.message(target, id, message)),
        answer: async (target, id, answer) => await report(target, wire.answer(target, id, answer)),
        stop: async (target, id) => await report(target, wire.stop(target, id)),
    };
};
