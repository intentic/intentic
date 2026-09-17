import { execFile } from "node:child_process";

// The one place the daemon spawns the fileq binary, shared by the background service that converges shadows, the
// route that derives a single file on demand and the diff route that derives a past version's bytes, so every caller
// bounds a child the same way and reads its refusals the same way.

export type ExecFn = (command: string, args: string[], options: { timeout: number; maxBuffer: number }) => Promise<{ stdout: string }>;

export const defaultExec: ExecFn = (command, args, options) =>
    new Promise((resolve, reject) => {
        execFile(command, args, options, (error, stdout) =>
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

// Interactive derivations run right now, across every caller. Opening a file or a diff asks for one without anyone
// pressing a button, so a reader walking a folder of documents would otherwise have a child process per file, all at
// once, on the box their agent is working on. One at a time past this, which is what the background pass already
// holds itself to for the same reason.
const MAX_CONCURRENT = 2;
const waiting: (() => void)[] = [];
let running = 0;

const acquire = async (): Promise<void> => {
    if (running < MAX_CONCURRENT) {
        running += 1;
        return;
    }
    // Woken already counted (see release): a waiter that incremented for itself would leave a gap between the
    // decrement and the wake-up, and a third caller arriving in that gap would find the count one too low.
    await new Promise<void>((resolve) => waiting.push(resolve));
};

const release = (): void => {
    const next = waiting.shift();
    if (next === undefined) {
        running -= 1;
        return;
    }
    // The slot is handed over rather than given back, so `running` never dips between the two.
    next();
};

/** Runs one fileq child inside the interactive slot budget; the slot is released however the work ends. */
export const withFileqSlot = async <T>(work: () => Promise<T>): Promise<T> => {
    await acquire();
    try {
        return await work();
    } finally {
        release();
    }
};
