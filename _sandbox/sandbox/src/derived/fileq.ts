import { execFile } from "node:child_process";
import { errorMessage } from "@intentic/base/errors";

// The one place the daemon spawns the fileq binary, shared by the route that derives a single file on demand and the
// diff route that derives a past version's bytes, so every caller bounds a child the same way and reads its refusals
// the same way.

export interface ExecOptions {
    readonly timeout: number;
    readonly maxBuffer: number;
    /** The child's whole environment; the daemon's own when absent. */
    readonly env?: NodeJS.ProcessEnv;
    readonly cwd?: string;
}

export type ExecFn = (command: string, args: string[], options: ExecOptions) => Promise<{ stdout: string }>;

export const defaultExec: ExecFn = (command, args, options) =>
    new Promise((resolve, reject) => {
        execFile(command, args, { ...options, encoding: "utf8" }, (error, stdout) =>
            // fileq names the reason it skipped a file on stdout and then exits 1, so the reason has to survive the
            // rejection or a caller can only report "it failed".
            error === null ? resolve({ stdout }) : reject(Object.assign(error, { stdout })),
        );
    });

/** Output a rejected spawn carried, when it got as far as printing one. */
export const stdoutOf = (error: unknown): string => {
    const carried = (error as { stdout?: unknown }).stdout;
    return typeof carried === "string" ? carried : "";
};

/** True when the failure was the binary not being there at all: a dev checkout, not a broken file. */
export const isMissingBinary = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";

// Derivation output is markdown, so a big shadow has to fit; the same ceiling for both callers.
export const FILEQ_MAX_BUFFER = 16 * 1024 * 1024;

// An interactive derive: long enough for a scanned pdf's OCR, short enough that a browser is not left holding a
// request nobody will wait for.
export const DERIVE_TIMEOUT_MS = 120_000;

/**
 * What ended a run that was not fileq's own exit-1 refusal (the time limit, a crash, an overflowing answer), worded for
 * a reader; undefined for a refusal, whose reason each caller reads from the stdout it printed.
 */
export const runFailure = (error: unknown): string | undefined => {
    const failed = error as { code?: unknown; killed?: unknown };
    if (failed.code === 1) {
        return undefined;
    }
    if (failed.killed === true) {
        return `fileq ran past its ${String(DERIVE_TIMEOUT_MS / 1000)}s limit and was stopped`;
    }
    return `fileq failed: ${errorMessage(error).split("\n")[0] ?? ""}`;
};

// Derivations run right now, across every caller. Opening a file or a diff asks for one without anyone pressing a
// button, so a reader walking a folder of documents would otherwise have a child process per file, all at once, on the
// box their agent is working on. Two at a time past this.
// The shadow keeper (shadow-keeper.ts) shares the same two slots at lower priority: it holds at most one, takes it only
// while no interactive caller is waiting, and a slot it gives back goes to a waiting interactive caller first. So a
// person opening a document never waits behind more than one background render, whatever the keeper has queued.
const MAX_CONCURRENT = 2;
const MAX_BACKGROUND = 1;
const interactiveWaiting: (() => void)[] = [];
const backgroundWaiting: (() => void)[] = [];
let running = 0;
let backgroundRunning = 0;

export type FileqPriority = "interactive" | "background";

const acquire = async (priority: FileqPriority): Promise<void> => {
    if (priority === "interactive") {
        if (running < MAX_CONCURRENT) {
            running += 1;
            return;
        }
        // Woken already counted (see release): a waiter that incremented for itself would leave a gap between the
        // decrement and the wake-up, and a third caller arriving in that gap would find the count one too low.
        await new Promise<void>((resolve) => interactiveWaiting.push(resolve));
        return;
    }
    if (running < MAX_CONCURRENT && backgroundRunning < MAX_BACKGROUND && interactiveWaiting.length === 0) {
        running += 1;
        backgroundRunning += 1;
        return;
    }
    await new Promise<void>((resolve) => backgroundWaiting.push(resolve));
};

const release = (priority: FileqPriority): void => {
    if (priority === "background") {
        backgroundRunning -= 1;
    }
    // The slot is handed over rather than given back, so `running` never dips between the two; interactive first.
    const interactive = interactiveWaiting.shift();
    if (interactive !== undefined) {
        interactive();
        return;
    }
    if (backgroundRunning < MAX_BACKGROUND) {
        const background = backgroundWaiting.shift();
        if (background !== undefined) {
            backgroundRunning += 1;
            background();
            return;
        }
    }
    running -= 1;
};

/** Runs one fileq child inside the slot budget; the slot is released however the work ends. */
export const withFileqSlot = async <T>(work: () => Promise<T>, priority: FileqPriority = "interactive"): Promise<T> => {
    await acquire(priority);
    try {
        return await work();
    } finally {
        release(priority);
    }
};

/** How the slots stand, for tests and the keeper's status. */
export const fileqSlots = () => ({
    running,
    background: backgroundRunning,
    waiting: interactiveWaiting.length + backgroundWaiting.length,
});
