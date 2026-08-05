import type { BootProgress, BootStep } from "@intentic/sandbox-contract";
import type { Logger } from "pino";

/* THE BOOT, AS STATE RATHER THAN AS ELAPSED TIME.
 *
 * The daemon listens before the state it serves has converged (main.ts: "listen first, converge behind the
 * gate"), so a restart stops reading as an outage. The cost of that trade was invisibility: for the first
 * seconds of every boot the daemon is reachable and unable to answer, and the only trace was a `boot: slow
 * step` log line nobody outside the container reads. The browser, seeing a live /events stream, painted an
 * operable workspace from its persisted cache and parked every request the user then made against the gate.
 *
 * So the boot names itself. Steps are DECLARED up front — the whole list, pending entries included — and each
 * transition is broadcast, which is what lets the browser show "4 of 11, loading the conversation registry"
 * and hold its reads until the gate opens. A boot that takes minutes has one slow step; the point of this
 * module is that the step gets named while it is still running, not after.
 *
 * A step that FAILS is finished, not fatal: the chain is log-and-continue by design (a failed sweep degrades
 * one subsystem, it must not hold the origin down), so `failed` is recorded and the chain moves on.
 *
 * Declaring is what CLOSES the gate. A tracker nobody declared a chain on is converged from birth and every
 * route answers at once — the shape tests and the host-internal preview want, where there is no chain to wait
 * for. That also makes the gate independent of construction order: `converged` is read per request, so it
 * cannot matter whether the app was built before or after main() declared the chain. */

export interface BootStepDeclaration<Key extends string = string> {
    readonly key: Key;
    readonly label: string;
}

// `Key` is how a caller that knows its whole chain up front (main.ts) gets the declaration checked by tsc
// instead of by the throw below. Nothing forces it — a tracker with no chain (tests, the preview) stays on the
// `string` default.
export interface BootTracker<Key extends string = string> {
    // Resolves when the chain has converged. The data routes await this; /health and /events never do.
    readonly converged: Promise<void>;
    // Declare the chain, in the order it runs, and close the gate behind it.
    declare(steps: readonly BootStepDeclaration<Key>[]): void;
    // Run one declared step, recording its state and elapsed time. Returns whatever `run` returns; a rejection
    // marks the step failed and propagates, so a caller's own catch still decides what a failure costs.
    step<T>(key: Key, run: () => Promise<T>): Promise<T>;
    // Open the gate: `converged` resolves and the progress reads ready.
    finish(): void;
    progress(): BootProgress;
    // Fires on every transition and on finish, with the snapshot that transition produced.
    subscribe(listener: (progress: BootProgress) => void): () => void;
}

// Past this, a step is worth a log line of its own — a healthy boot stays quiet, and anything slower than this
// is what someone reading the log is looking for.
const SLOW_STEP_MS = 1_000;

export const createBootTracker = (logger: Logger): BootTracker => {
    const startedAt = Date.now();
    let steps: BootStep[] = [];
    // The gate, created by declare() and resolved by finish(). Undefined means nothing was ever declared.
    let gate: { readonly promise: Promise<void>; readonly open: () => void } | undefined;
    const listeners = new Set<(progress: BootProgress) => void>();

    // A fresh object per snapshot: it goes onto a stream as a frame, and a shared mutable array would let a
    // later transition rewrite a frame already yielded.
    const progress = (): BootProgress => ({
        ready: gate === undefined,
        startedAt,
        steps: steps.map((step) => ({ ...step })),
    });

    const broadcast = (): void => {
        const snapshot = progress();
        for (const listener of listeners) {
            listener(snapshot);
        }
    };

    const entry = (key: string): BootStep => {
        const found = steps.find((step) => step.key === key);
        if (found === undefined) {
            // Guarded by discovery rather than by review: an undeclared step is one the browser would never
            // show, and a boot that silently loses a minute to an unnamed step is exactly what this replaces.
            throw new Error(`boot step '${key}' was run without being declared`);
        }
        return found;
    };

    return {
        get converged() {
            return gate?.promise ?? Promise.resolve();
        },
        declare: (declared) => {
            steps = declared.map(({ key, label }) => ({ key, label, state: "pending" }));
            let open!: () => void;
            const promise = new Promise<void>((resolve) => {
                open = resolve;
            });
            gate = { promise, open };
            broadcast();
        },
        step: async (key, run) => {
            const step = entry(key);
            step.state = "running";
            broadcast();
            const from = performance.now();
            try {
                return await run();
            } catch (error) {
                step.state = "failed";
                throw error;
            } finally {
                step.ms = Math.round(performance.now() - from);
                step.state = step.state === "failed" ? "failed" : "done";
                if (step.ms > SLOW_STEP_MS) {
                    logger.info({ step: key, ms: step.ms }, "boot: slow step");
                }
                broadcast();
            }
        },
        finish: () => {
            const open = gate?.open;
            if (open === undefined) {
                return;
            }
            gate = undefined;
            logger.info({ ms: Date.now() - startedAt, steps: steps.length }, "boot: converged");
            open();
            broadcast();
        },
        progress,
        subscribe: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
    };
};
