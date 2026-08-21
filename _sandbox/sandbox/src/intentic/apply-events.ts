import { type FileHandle, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
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

// Tail an intentic events file: replay it from the start (so a refresh mid-run rebuilds the full view), then
// follow appended lines live. Ends the stream on the line `isTerminal` accepts (the apply job passes
// isTerminalExit, clean apply/resolve exits keep it open through the chain; a check run ends on any exit);
// falls back to !isRunning() when the run died without writing one (SIGKILL). A newer run truncating the file
// mid-tail (its size dropping below our read offset) also ends the stream, the client reconnects and gets
// the new run from its own {kind:"start"}. Only newline-terminated lines are parsed and each CLI event is one
// atomic writeSync, so a torn/partial line never reaches parseIntenticLine.
export async function* tailIntenticEvents(
    path: string,
    isTerminal: (line: IntenticLine) => boolean,
    isRunning: () => boolean,
    signal: AbortSignal | undefined,
): AsyncGenerator<IntenticLine> {
    const abort = signal ?? new AbortController().signal;
    let handle: FileHandle;
    try {
        handle = await open(path, "r");
    } catch {
        return; // ENOENT: no apply has ever run (or the file was cleaned up); nothing to tail.
    }
    try {
        let offset = 0;
        let buffer = "";
        while (!abort.aborted) {
            const { size } = await handle.stat();
            if (size < offset) {
                return; // a newer apply reset the file: end so the client reconnects to the new run's start.
            }
            if (size > offset) {
                const length = size - offset;
                const chunk = Buffer.allocUnsafe(length);
                const { bytesRead } = await handle.read(chunk, 0, length, offset);
                offset += bytesRead;
                buffer += chunk.toString("utf8", 0, bytesRead);
                let index = buffer.indexOf("\n");
                while (index !== -1) {
                    const line = parseIntenticLine(buffer.slice(0, index));
                    buffer = buffer.slice(index + 1);
                    if (line !== undefined) {
                        yield line;
                        if (isTerminal(line)) {
                            return; // the whole run finished (success or failure): nothing more will be written.
                        }
                    }
                    index = buffer.indexOf("\n");
                }
                continue; // drain everything currently available before deciding to wait or close.
            }
            // No new bytes: if the tmux job is gone it died without an {kind:"exit"} line (SIGKILL), close;
            // otherwise emit a heartbeat (keeps the held-open stream/tunnel alive) and poll again.
            if (!isRunning()) {
                return;
            }
            yield { kind: "heartbeat" };
            // Poll interval, woken immediately on abort. node's timers/promises setTimeout adds then removes its
            // own abort listener per call, so a long-lived tail can't accumulate listeners on the signal the way
            // a hand-rolled addEventListener (fired once, never removed) would.
            try {
                await sleep(1000, undefined, { signal: abort });
            } catch {
                return; // aborted mid-wait: stop tailing (same outcome as the while (!abort.aborted) guard)
            }
        }
    } finally {
        await handle.close();
    }
}
