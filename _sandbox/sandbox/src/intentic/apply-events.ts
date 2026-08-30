import { type FSWatcher, watch } from "node:fs";
import { type FileHandle, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { parseIntenticLine } from "./intentic-runner.js";

// The durable per-run apply event log. `intentic deploy apply` mirrors its ndjson lifecycle stream here (via the CLI's
// INTENTIC_EVENTS_FILE sink) while the human-readable pane runs in the panel-infra-apply tmux session; the web
// tails this file so per-resource apply progress survives a page refresh. Lives under historyRoot alongside
// activity.jsonl, daemon-owned, outside the agent's reach and outside the desired-state repo (it is per-run
// telemetry, never committed), and deliberately NOT under logs/, whose copy-truncate pruner would race a tail.
// A single fixed path, truncated per run, so there is nothing to rotate.
export const applyEventsPath = (historyRoot: string): string => join(historyRoot, "apply-events.ndjson");

// Truncate the file and write the {kind:"start"} marker. Called BEFORE the run launches (and before the route
// returns), so any reader that opens after the POST resolves sees a fresh file, never the previous run's
// trailing {kind:"exit"} line.
export const resetEventsFile = async (path: string): Promise<void> => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ kind: "start", startedAt: Date.now() })}\n`);
};

// Whether an event line ends the WHOLE apply job. The job command is `apply && adopt`, or the service
// capability's `resolve && apply --yes && adopt`, so: any command's non-zero exit is terminal (`&&` stops the
// chain), a clean exit is terminal only for adopt (it runs last) or for an untagged exit line (a
// single-command file). Clean resolve/apply exits keep the tail open, the chain continues.
export const isTerminalExit = (line: IntenticLine): boolean => {
    if (line.kind !== "exit") {
        return false;
    }
    return line["code"] !== 0 || line["command"] === "adopt" || line["command"] === undefined;
};

// Whether the event log records a run that started and has not terminally exited, the boot-time check that
// keeps a daemon restart from sweeping a live apply session (main.ts adopts it instead).
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

/* HOW THE TAIL WAITS, and the whole reason this is no longer a poll.
 *
 * A line appended to this file is a local write on a local filesystem, so the kernel can say so the moment it
 * happens. `fs.watch` is what asks it to. What stood here before was a stat every second, which put a delay of
 * up to a second in front of EVERY line: a hundred-resource apply spent a hundred of them waiting on a file that
 * had already been written, all of it in front of a progress bar somebody is watching.
 *
 * THE TIMEOUT STAYS, and it is not the poll wearing a hat, it is the two things no write will ever announce:
 *   • a job SIGKILLed without an {kind:"exit"} line, where nothing more will EVER be written, so a clock is the
 *     only thing that can notice;
 *   • the heartbeat frame that holds the held-open stream, and every tunnel and proxy in its path, open.
 * Both are the loop's own business rather than the file's, which is why they keep a clock and the data does not.
 *
 * A watcher that cannot be created, or that dies under us (an inotify limit, a filesystem with no change
 * notification, a file REPLACED rather than truncated), costs this tail its liveness and never its correctness:
 * falling back to the timeout alone is exactly the loop this replaced. */
const IDLE_WAKE_MS = 1000;

interface TailWaker {
    /* Waits for the file's next write, for `idleWakeMs`, or for `signal` to abort, whichever lands first.
     * Answers WHICH of them it was: true for a write, false for the clock or the abort. The caller heartbeats
     * on false alone, so a stream that just delivered a line does not also send a keepalive. */
    readonly wait: (signal: AbortSignal, idleWakeMs: number) => Promise<boolean>;
    readonly close: () => void;
}

const tailWaker = (path: string): TailWaker => {
    let watcher: FSWatcher | undefined;
    /* A write that landed while the loop was reading and yielding the last batch. Held as a flag rather than
     * raced against, so the next wait returns at once instead of sleeping out the interval on news it already
     * has, which is the one way an event-driven tail can still deliver a line late. */
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
                // Removes its own abort listener, so a tail held open for the length of an apply cannot
                // accumulate one per wait on a signal that only ever fires once. Never called before the
                // timer below exists: every one of its three callers is asynchronous.
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

/* Split what has been read so far into whole events and the partial tail still waiting for its newline. Only
 * newline-terminated lines are parsed, and each CLI event is one atomic writeSync, so a torn write is held back
 * here rather than reaching parseIntenticLine as a half line. Blank and unparseable lines are dropped. */
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

// Tail an intentic events file: replay it from the start (so a refresh mid-run rebuilds the full view), then
// follow appended lines live, woken by the write itself (tailWaker). Ends the stream on the line `isTerminal`
// accepts (the apply job passes isTerminalExit, clean apply/resolve exits keep it open through the chain; a
// check run ends on any exit); falls back to !isRunning() when the run died without writing one (SIGKILL). A
// newer run truncating the file mid-tail (its size dropping below our read offset) also ends the stream, the
// client reconnects and gets the new run from its own {kind:"start"}. Only newline-terminated lines are parsed
// and each CLI event is one atomic writeSync, so a torn/partial line never reaches parseIntenticLine.
export async function* tailIntenticEvents(
    path: string,
    isTerminal: (line: IntenticLine) => boolean,
    isRunning: () => boolean,
    signal: AbortSignal | undefined,
    // How long an idle tail waits before looking at the job's liveness and sending a keepalive. Injectable for
    // the same reason the daemon's other loops take their interval: a test drives it instead of racing a clock.
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
                /* Otherwise sleep until the file is written, the job's death is due a look, or the caller lets
                 * go. An abort resolves this rather than throwing; the loop's own guard is what ends the tail.
                 *
                 * THE HEARTBEAT BELONGS TO THE TIMEOUT, NOT TO THE LOOP. Draining a batch also lands here with
                 * nothing left to send, and that is not the same as being idle: keepaliving on it would bill a
                 * chatty apply a frame per write, more than the poll this replaced ever sent. Silence is what
                 * the far end needs reassuring about, so silence is what answers with a heartbeat. */
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
