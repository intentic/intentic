import { type FSWatcher, watch } from "node:fs";
import { type FileHandle, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { parseIntenticLine } from "./intentic-runner.js";

// Durable per-run apply event log; the CLI mirrors its ndjson stream here so a page refresh can resume the tail. Lives
// under historyRoot (not logs/, whose pruner would race a tail); one fixed path, truncated per run.
export const applyEventsPath = (historyRoot: string): string => join(historyRoot, "apply-events.ndjson");

// Truncates the file and writes the start marker before the run launches, so any reader opening after resolves sees a
// fresh file, never the previous run's trailing exit line.
export const resetEventsFile = async (path: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ kind: "start", startedAt: Date.now() })}\n`);
};

// Whether an event line ends the whole job (`apply && adopt`, or `resolve && apply && adopt`). Any non-zero exit is
// terminal; a clean exit is terminal only for adopt or an untagged line, resolve/apply's clean exits keep the tail
// open.
export const isTerminalExit = (line: IntenticLine): boolean => {
    if (line.kind !== "exit") {
        return false;
    }
    return line["code"] !== 0 || line["command"] === "adopt" || line["command"] === undefined;
};

// Whether the log shows a run that started but has not terminally exited; the boot check that stops a restart from
// sweeping a live apply.
export const applyRunLive = async (path: string): Promise<boolean> => {
    let content: string;
    try {
        content = await readFile(path, "utf8");
    } catch {
        return false; // never ran (or cleaned up): nothing to protect.
    }
    let started = false;
    for (const raw of content.split("\n")) {
        const line = parseIntenticLine(raw);
        if (line === undefined) {
            continue;
        }
        if (line.kind === "start") {
            started = true;
        }
        if (isTerminalExit(line)) {
            return false;
        }
    }
    return started;
};

// fs.watch announces a write immediately, replacing a per-second poll. The timeout stays for what no write announces: a
// SIGKILLed job with no exit line, and the heartbeat keeping the connection open.
const IDLE_WAKE_MS = 1000;

interface TailWaker {
    // Waits for the next write, the idle timeout, or an abort, whichever comes first; true only for a write. The caller
    // heartbeats on false, never on a delivered line.
    readonly wait: (signal: AbortSignal, idleWakeMs: number) => Promise<boolean>;
    readonly close: () => void;
}

const tailWaker = (path: string): TailWaker => {
    let watcher: FSWatcher | undefined;
    // A write landed while the last batch was being read; held as a flag so the next wait returns immediately.
    let written = false;
    let wake: (() => void) | undefined;
    const drop = (): void => {
        watcher?.close();
        watcher = undefined;
    };
    try {
        watcher = watch(path, () => {
            written = true;
            wake?.();
        });
        watcher.on("error", drop);
    } catch {
        watcher = undefined;
    }
    return {
        wait: async (signal, idleWakeMs) => {
            if (signal.aborted) {
                return false;
            }
            if (written) {
                written = false;
                return true;
            }
            const wrote = await new Promise<boolean>((resolve) => {
                // Removes its abort listener so a long tail doesn't accumulate one per wait on a signal that only fires
                // once.
                const done = (byWrite: boolean): void => {
                    clearTimeout(timer);
                    signal.removeEventListener("abort", stopped);
                    wake = undefined;
                    resolve(byWrite);
                };
                const stopped = (): void => done(false);
                const timer = setTimeout(stopped, idleWakeMs);
                wake = () => done(true);
                signal.addEventListener("abort", stopped, { once: true });
            });
            written = false;
            return wrote;
        },
        close: drop,
    };
};

// Splits buffered text into whole events and the partial tail awaiting its newline; a torn write from an atomic
// writeSync is held back rather than parsed half-formed.
const drainLines = (buffer: string): { lines: IntenticLine[]; rest: string } => {
    const lines: IntenticLine[] = [];
    let rest = buffer;
    let index = rest.indexOf("\n");
    while (index !== -1) {
        const line = parseIntenticLine(rest.slice(0, index));
        rest = rest.slice(index + 1);
        index = rest.indexOf("\n");
        if (line !== undefined) {
            lines.push(line);
        }
    }
    return { lines, rest };
};

// Replays from the start, then follows live, woken by the write. Ends when `isTerminal` accepts a line, or
// `!isRunning()` catches a SIGKILL with no exit line; a truncated file also ends the stream, so the client reconnects
// fresh.
export async function* tailIntenticEvents(
    path: string,
    isTerminal: (line: IntenticLine) => boolean,
    isRunning: () => boolean,
    signal: AbortSignal | undefined,
    // How long an idle tail waits before a liveness check and heartbeat; injectable so tests drive it, not a clock.
    idleWakeMs: number = IDLE_WAKE_MS,
): AsyncGenerator<IntenticLine> {
    const abort = signal ?? new AbortController().signal;
    let handle: FileHandle;
    try {
        handle = await open(path, "r");
    } catch {
        return; // ENOENT: no apply has ever run (or the file was cleaned up); nothing to tail.
    }
    // Armed only once the file is known to exist, so the absent-file path above never reaches the kernel.
    const waker = tailWaker(path);
    try {
        let offset = 0;
        let buffer = "";
        while (!abort.aborted) {
            const { size } = await handle.stat();
            if (size < offset) {
                return; // a newer apply reset the file: end so the client reconnects to the new run's start.
            }
            if (size === offset) {
                // No new bytes: if the tmux job is gone it died without an {kind:"exit"} line (SIGKILL), close.
                if (!isRunning()) {
                    return;
                }
                // Heartbeat belongs to the timeout, not the loop: an empty drain isn't idle and must not trigger one
                // itself.
                if (!(await waker.wait(abort, idleWakeMs))) {
                    yield { kind: "heartbeat" };
                }
                continue;
            }
            const length = size - offset;
            const chunk = Buffer.allocUnsafe(length);
            const { bytesRead } = await handle.read(chunk, 0, length, offset);
            offset += bytesRead;
            buffer += chunk.toString("utf8", 0, bytesRead);
            // Drain everything currently available before deciding to wait or close.
            const drained = drainLines(buffer);
            buffer = drained.rest;
            for (const line of drained.lines) {
                yield line;
                if (isTerminal(line)) {
                    return; // the whole run finished (success or failure): nothing more will be written.
                }
            }
        }
    } finally {
        waker.close();
        await handle.close();
    }
}
