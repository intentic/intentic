import { onFileChange } from "./file-changes.js";

// WAITING ON A PROGRAM app_start STARTED, SO AN AGENT ASKS ONCE INSTEAD OF CALLING app_logs AGAIN AND AGAIN (2026-10-20).
// Each wait ends on the event it is about: a line landing in the log (the folder watch) or the program's own exit. The
// timers here are a cap (the caller's timeout) and a slow fallback for the cases with no event to hear.

// A re-read of the log this often whatever the watch says: fs.watch is silent on some file systems (network drives,
// some WSL mounts), and a missed event must cost at most this much, never the whole timeout.
export const LOG_FALLBACK_MS = 2_000;
// How often a run this agent holds no handle for (started by an earlier agent, or inside Windows Sandbox) is looked at:
// a stranger's exit raises no event here, so this check is the only way to see it.
const END_FALLBACK_MS = 500;

export type LogWaitOutcome = "matched" | "ended" | "timeout";

export interface LogWait {
    readonly path: string;
    readonly pattern: RegExp;
    readonly timeoutMs: number;
    // The log's current text (its tail); answers "" while there is none.
    readonly read: () => Promise<string>;
    // Settles when the program has ended: no line will come after that, so the wait need not run to its timeout.
    readonly ended?: Promise<unknown> | undefined;
}

// Answers on the first read that matches, re-reading on every change the watch reports. One read runs at a time; a
// change during a read asks for one more, so the line that landed mid-read is not missed.
export const waitForLogMatch = async ({ path, pattern, timeoutMs, read, ended }: LogWait): Promise<LogWaitOutcome> =>
    await new Promise((resolve) => {
        let done = false;
        let reading = false;
        let again = false;
        const stops: (() => void)[] = [];
        const finish = (outcome: LogWaitOutcome): void => {
            if (done) {
                return;
            }
            done = true;
            for (const stop of stops) {
                stop();
            }
            resolve(outcome);
        };
        const check = async (): Promise<boolean> => {
            if (done) {
                return false;
            }
            if (reading) {
                again = true;
                return false;
            }
            reading = true;
            try {
                do {
                    again = false;
                    // allow(silent-catch): a log unreadable for now (being rotated, locked on Windows) is read again on the next change.
                    if (pattern.test(await read().catch(() => ""))) {
                        finish("matched");
                        return true;
                    }
                } while (again);
                return false;
            } finally {
                reading = false;
            }
        };
        const cap = setTimeout(() => finish("timeout"), timeoutMs);
        const fallback = setInterval(() => void check(), LOG_FALLBACK_MS);
        stops.push(() => clearTimeout(cap), () => clearInterval(fallback));
        const unwatch = onFileChange(path, () => void check());
        if (unwatch !== undefined) {
            stops.push(unwatch);
        }
        // Watching before the first read: a line written between the two is then heard rather than lost.
        void check();
        // The last read after the end, for output flushed as the program exited.
        const lastRead = async (): Promise<void> => {
            let text = "";
            try {
                text = await read();
            } catch {
                // allow(silent-catch): an unreadable log at the end matches nothing, which "ended" then says.
            }
            finish(pattern.test(text) ? "matched" : "ended");
        };
        void ended?.then(lastRead);
    });

export interface EndWait {
    readonly timeoutMs: number;
    // The run's own exit (the child's `exit` event and its record written) when this agent started it.
    readonly exit?: Promise<unknown> | undefined;
    // Whether the run has ended, by its record and pid: for a run with no exit to hear.
    readonly isEnded: () => Promise<boolean>;
    readonly fallbackMs?: number | undefined;
    // Ends the wait early, answering as things stand: for a caller that got what it waited for another way.
    readonly signal?: AbortSignal | undefined;
}

// Whether the run ended within the timeout. A run this agent holds is answered by its exit event; any other is looked
// at every `fallbackMs`, there being nothing to hear from it.
export const waitForEnd = async ({ timeoutMs, exit, isEnded, fallbackMs = END_FALLBACK_MS, signal }: EndWait): Promise<boolean> => {
    if (await isEnded()) {
        return true;
    }
    await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
            if (done) {
                return;
            }
            done = true;
            clearTimeout(cap);
            clearInterval(look);
            signal?.removeEventListener("abort", finish);
            resolve();
        };
        const cap = setTimeout(finish, timeoutMs);
        const look =
            exit === undefined
                ? setInterval(() => void isEnded().then((gone) => gone && finish(), () => undefined), fallbackMs)
                : undefined;
        void exit?.then(finish, finish);
        if (signal?.aborted === true) {
            finish();
        }
        signal?.addEventListener("abort", finish);
    });
    return await isEnded();
};
