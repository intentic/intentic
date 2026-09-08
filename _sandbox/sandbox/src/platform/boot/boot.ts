import type { BootProgress, BootStep } from "@intentic/sandbox-contract";
import type { Logger } from "pino";

// Tracks boot as named, declared steps rather than elapsed time, so a restart reads as progress instead of an outage.
// Declaring a chain closes the gate until finish() opens it; a tracker with no declared chain is converged from birth.
// A failed step is recorded and the chain continues; failure here is not fatal to boot.

export interface BootStepDeclaration<Key extends string = string> {
    readonly key: Key;
    readonly label: string;
}

// `Key` lets a caller with a known chain (main.ts) get its declarations checked by tsc instead of at runtime.
export interface BootTracker<Key extends string = string> {
    // Resolves once the chain converges; data routes await it, /health and /events never do.
    readonly converged: Promise<void>;
    // Declares the chain, in run order, and closes the gate until finish().
    declare(steps: readonly BootStepDeclaration<Key>[]): void;
    // Runs one declared step, recording its state and elapsed time, and returns what `run` returns. A rejection marks
    // the step failed and still propagates.
    step<T>(key: Key, run: () => Promise<T>): Promise<T>;
    // Opens the gate: `converged` resolves and progress reads ready.
    finish(): void;
    progress(): BootProgress;
    // Fires on every transition and on finish, with the snapshot that transition produced.
    subscribe(listener: (progress: BootProgress) => void): () => void;
}

// Steps slower than this get their own log line; a healthy boot stays quiet.
const SLOW_STEP_MS = 1_000;

export const createBootTracker = (logger: Logger): BootTracker => {
    const startedAt = Date.now();
    let steps: BootStep[] = [];
    // The gate created by declare() and resolved by finish(); undefined means nothing has been declared.
    let gate: { readonly promise: Promise<void>; readonly open: () => void } | undefined;
    const listeners = new Set<(progress: BootProgress) => void>();

    // A fresh object per snapshot: it goes onto a stream as a frame, and a shared mutable array would let a later
    // transition rewrite an already-yielded frame.
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
            // An undeclared step would never show progress to the browser, so this is guarded at runtime, not by
            // review.
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
