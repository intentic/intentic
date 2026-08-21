import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { afterEach, beforeEach, expect, test } from "vitest";
import { applyEventsPath, applyRunLive, isTerminalExit, resetEventsFile, tailIntenticEvents } from "./apply-events.js";

const line = (value: Record<string, unknown>): string => `${JSON.stringify(value)}\n`;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const collect = async (gen: AsyncGenerator<IntenticLine>): Promise<string[]> => {
    const out: string[] = [];
    for await (const value of gen) {
        out.push(value.kind);
    }
    return out;
};

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "apply-events-"));
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

test("resetEventsFile truncates and writes the start marker", async () => {
    const path = applyEventsPath(dir);
    await writeFile(path, line({ kind: "stale" }) + line({ kind: "exit", code: 1 }));
    await resetEventsFile(path);
    // A fresh reader sees only the new run's start, never the previous run's exit.
    expect(await collect(tailIntenticEvents(path, isTerminalExit, () => false, undefined))).toEqual(["start"]);
});

test("replays from the start and closes on the exit line", async () => {
    const path = applyEventsPath(dir);
    await writeFile(
        path,
        line({ kind: "start" }) +
            line({ kind: "node", phase: "apply", state: "done", id: "shop.production", action: "create" }) +
            line({ kind: "result", converged: true }) +
            line({ kind: "exit", code: 0 }),
    );
    // Not running, but the exit line ends the stream regardless: everything up to and including it replays.
    expect(await collect(tailIntenticEvents(path, isTerminalExit, () => false, undefined))).toEqual(["start", "node", "result", "exit"]);
});

test("ignores blank lines and returns immediately when the file is absent", async () => {
    expect(await collect(tailIntenticEvents(join(dir, "missing.ndjson"), isTerminalExit, () => false, undefined))).toEqual([]);
    const path = applyEventsPath(dir);
    await writeFile(path, `${line({ kind: "start" })}\n   \n${line({ kind: "exit", code: 0 })}`);
    expect(await collect(tailIntenticEvents(path, isTerminalExit, () => false, undefined))).toEqual(["start", "exit"]);
});

test("closes without an exit line once the job is gone (SIGKILL fallback)", async () => {
    const path = applyEventsPath(dir);
    await writeFile(path, line({ kind: "start" }) + line({ kind: "node", phase: "apply", state: "start", id: "db" }));
    // No exit line and the tmux session is already gone → drain what's there, then close.
    expect(await collect(tailIntenticEvents(path, isTerminalExit, () => false, undefined))).toEqual(["start", "node"]);
});

test("follows lines appended live while the job runs, heartbeating when idle", async () => {
    const path = applyEventsPath(dir);
    await resetEventsFile(path);
    let running = true;
    // The job appends more events after the first idle heartbeat, then exits.
    const appending = (async () => {
        await delay(150);
        await appendFile(path, line({ kind: "node", phase: "apply", state: "done", id: "route", action: "update" }));
        await appendFile(path, line({ kind: "exit", code: 0 }));
        running = false;
    })();
    const kinds = await collect(tailIntenticEvents(path, isTerminalExit, () => running, undefined));
    await appending;
    expect(kinds).toEqual(["start", "heartbeat", "node", "exit"]);
});

test("clean apply/resolve exits keep the tail open through the chain; adopt's exit ends it", async () => {
    const path = applyEventsPath(dir);
    await resetEventsFile(path);
    let running = true;
    const appending = (async () => {
        await delay(150);
        // The service capability's chain: resolve exits 0, then apply converges and exits 0, the tail must
        // stay open through both, adopt is still to come.
        await appendFile(path, line({ kind: "exit", command: "resolve", code: 0 }));
        await appendFile(path, line({ kind: "result", converged: true }) + line({ kind: "exit", command: "apply", code: 0 }));
        await delay(150);
        await appendFile(path, line({ kind: "exit", command: "adopt", code: 0 }));
        running = false;
    })();
    const kinds = await collect(tailIntenticEvents(path, isTerminalExit, () => running, undefined));
    await appending;
    // All exits are yielded; only adopt's closes the stream (heartbeats interleave while idle).
    expect(kinds.filter((kind) => kind !== "heartbeat")).toEqual(["start", "exit", "result", "exit", "exit"]);
});

test("a failed apply's or resolve's exit is terminal: the && chain stops there", async () => {
    const path = applyEventsPath(dir);
    await writeFile(path, line({ kind: "start" }) + line({ kind: "exit", command: "apply", code: 1 }));
    expect(await collect(tailIntenticEvents(path, isTerminalExit, () => true, undefined))).toEqual(["start", "exit"]);
    await writeFile(path, line({ kind: "start" }) + line({ kind: "exit", command: "resolve", code: 1 }));
    expect(await collect(tailIntenticEvents(path, isTerminalExit, () => true, undefined))).toEqual(["start", "exit"]);
});

test("a check run's tail ends on any exit: single-command files carry exactly one", async () => {
    const path = join(dir, "check.ndjson");
    await writeFile(path, line({ kind: "start" }) + line({ kind: "result", steps: [] }) + line({ kind: "exit", command: "plan", code: 0 }));
    expect(
        await collect(
            tailIntenticEvents(
                path,
                (event) => event.kind === "exit",
                () => true,
                undefined,
            ),
        ),
    ).toEqual(["start", "result", "exit"]);
});

test("applyRunLive reports a started-but-not-exited run, and only that", async () => {
    const path = applyEventsPath(dir);
    expect(await applyRunLive(path)).toBe(false); // never ran
    await resetEventsFile(path);
    expect(await applyRunLive(path)).toBe(true); // started, no exit — a live run to protect
    await appendFile(path, line({ kind: "exit", command: "resolve", code: 0 }));
    expect(await applyRunLive(path)).toBe(true); // resolve done, apply still running
    await appendFile(path, line({ kind: "exit", command: "apply", code: 0 }));
    expect(await applyRunLive(path)).toBe(true); // apply done, adopt still running
    await appendFile(path, line({ kind: "exit", command: "adopt", code: 0 }));
    expect(await applyRunLive(path)).toBe(false); // whole job finished
});

test("ends the stream when a newer run truncates the file mid-tail", async () => {
    const path = applyEventsPath(dir);
    await writeFile(path, line({ kind: "start" }) + line({ kind: "node", phase: "apply", state: "start", id: "db" }));
    let running = true;
    // After the first heartbeat, a newer apply resets the file (smaller than our read offset) → we close.
    const resetting = (async () => {
        await delay(150);
        await resetEventsFile(path);
        running = false;
    })();
    const kinds = await collect(tailIntenticEvents(path, isTerminalExit, () => running, undefined));
    await resetting;
    // start + node replayed, one idle heartbeat, then the truncation ends the stream (no second run's start).
    expect(kinds).toEqual(["start", "node", "heartbeat"]);
});
