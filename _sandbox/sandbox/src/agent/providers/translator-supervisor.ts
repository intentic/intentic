import type { Readable } from "node:stream";
import { createBackoff } from "@intentic/base/async";
import type { Logger } from "pino";
import { noteEngineServing, type ResolvedEngine } from "../../engines/engine-resolve.js";

// Keeps one CLIProxyAPI process alive on whichever copy the engine store selects. The binary is resolved once per
// spawn, so an Environment-card update or revert used to leave the old copy serving until the process died on its own
// while the card already named the new one. The swap check retires a proxy whose copy is no longer the selected one,
// but only while no turn is running: a restart cuts every routed request in flight.

// Restart backoff: 10s doubling to 5min; a run past a minute resets the ladder (createBackoff).
const RESTART_LADDER = { floorMs: 10_000, capMs: 300_000, stableMs: 60_000 } as const;

// The tail of the proxy's output kept per run, enough to carry a Go panic or a bind error into the exit log.
const OUTPUT_TAIL_BYTES = 2_048;

// The copy to run, with the binary it resolves to (the store's, the image's on PATH, or the bare name).
export type TranslatorCopy = ResolvedEngine & { readonly binary: string };

// What the supervisor touches of a spawned proxy; a ChildProcess is one.
export interface TranslatorProcess {
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    kill(signal?: NodeJS.Signals | number): boolean;
    on(event: "exit", listener: (code: number | null, signal: NodeJS.Signals | null) => void): this;
}

export interface TranslatorSupervisorDeps {
    readonly resolve: () => Promise<TranslatorCopy>;
    // Writes the proxy's config and spawns it on this binary.
    readonly spawn: (binary: string) => Promise<TranslatorProcess>;
    // Whether a turn is running anywhere on this daemon; any of them may be talking to the proxy.
    readonly busy: () => boolean;
    readonly logger: Pick<Logger, "info" | "warn">;
    // Seam for a suite; defaults to the real timer.
    readonly schedule?: (fn: () => void, ms: number) => void;
}

export interface TranslatorSupervisor {
    readonly start: () => Promise<void>;
    // Retires the running proxy when its copy is no longer the selected one and nothing is mid-turn; the exit handler
    // respawns it at once on the selected copy. Answers whether it did.
    readonly swapIfStale: () => Promise<boolean>;
}

export const superviseTranslator = (deps: TranslatorSupervisorDeps): TranslatorSupervisor => {
    const { logger } = deps;
    const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms).unref());
    const ladder = createBackoff(RESTART_LADDER);
    let child: TranslatorProcess | undefined;
    let runningBinary: string | undefined;
    let swapping = false;

    const start = async (): Promise<void> => {
        const copy = await deps.resolve();
        const startedAt = Date.now();
        // The proxy logs its exit reason on stdout, not stderr; both streams are captured, in order.
        let outputTail = "";
        const keepTail = (chunk: Buffer): void => {
            outputTail = (outputTail + chunk.toString()).slice(-OUTPUT_TAIL_BYTES);
        };
        const spawned = await deps.spawn(copy.binary);
        child = spawned;
        runningBinary = copy.binary;
        noteEngineServing("translator", copy);
        spawned.stdout?.on("data", keepTail);
        spawned.stderr?.on("data", keepTail);
        spawned.on("exit", (code) => {
            child = undefined;
            runningBinary = undefined;
            noteEngineServing("translator", undefined);
            const restart = (): void => void start().catch((error) => logger.warn({ err: error }, "translator restart failed"));
            if (swapping) {
                // Deliberate, so neither a crash nor a step up the backoff ladder.
                swapping = false;
                restart();
                return;
            }
            const restartInMs = ladder.next(Date.now() - startedAt);
            logger.warn({ code, output: outputTail.trim(), restartInMs }, "translator: cli-proxy-api exited, restarting");
            schedule(restart, restartInMs);
        });
    };

    const swapIfStale = async (): Promise<boolean> => {
        if (child === undefined || swapping || deps.busy()) {
            return false;
        }
        const selected = await deps.resolve();
        // Asked again after the await: the proxy may have exited, or a turn started, meanwhile.
        const current = child;
        if (current === undefined || swapping || selected.binary === runningBinary || deps.busy()) {
            return false;
        }
        swapping = true;
        logger.info({ from: runningBinary, to: selected.binary }, "translator: restarting onto the selected engine version");
        current.kill("SIGTERM");
        return true;
    };

    return { start, swapIfStale };
};
