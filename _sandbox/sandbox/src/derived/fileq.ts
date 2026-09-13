import { execFile } from "node:child_process";

// The one place the daemon spawns the fileq binary, shared by the background service that converges shadows and the
// route that derives a single file on demand, so both bound a child the same way and both read its refusals.

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
