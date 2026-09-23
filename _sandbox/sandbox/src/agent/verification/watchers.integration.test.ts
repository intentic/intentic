import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { afterEach, beforeEach, expect, it } from "bun:test";
import { waitFor } from "@intentic/testing/bun";
import { type FakeTurns, fakeTurns, memoryFleet } from "../../testing.js";
import { memoryWatchJournal } from "./watch-journal.js";
import { armWatcher, armedWatcherCount, type CheckResult, startWatcherRuntime, type WatcherSpec } from "./watchers.js";

// Real timers and a real directory: the signal is a filesystem event, and the floor is set far enough out that only the
// event can pass.

let dir: string;
let checks: string[];
let doors: FakeTurns;
let check: CheckResult;
let stop: () => void;

beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "watch-signal-"));
    checks = [];
    doors = fakeTurns();
    check = { exitCode: 1, output: "still waiting" };
    stop = startWatcherRuntime({
        logger: pino({ level: "silent" }),
        runCheck: (command) => {
            checks.push(command);
            return Promise.resolve(check);
        },
        turns: doors.turns,
        sessionIdOf: () => undefined,
        journal: memoryWatchJournal(),
        envOf: () => Promise.resolve({}),
        conversationLive: () => true,
        conversations: memoryFleet().conversations,
    });
});

afterEach(() => {
    stop();
    rmSync(dir, { recursive: true, force: true });
});

const specOf = (signalPath: string): WatcherSpec => ({
    conversationId: "conv-1",
    command: `test -f ${signalPath}`,
    note: "a background job",
    intervalSeconds: 1_800,
    timeoutSeconds: 3_600,
    cwd: dir,
    env: {},
    signalPath,
    profile: {},
});

it("checks the moment the signal file lands, not at the next interval", async () => {
    const signalPath = join(dir, "status");
    expect((await armWatcher(specOf(signalPath))).kind).toBe("armed");
    check = { exitCode: 0, output: "exit 0" };
    writeFileSync(signalPath, "0\n");
    await waitFor(() => expect(doors.started).toHaveLength(1));
    expect(checks).toHaveLength(2);
    expect(armedWatcherCount()).toBe(0);
});

it("keeps the interval as the floor when the signal file never comes", async () => {
    expect((await armWatcher(specOf(join(dir, "never")))).kind).toBe("armed");
    writeFileSync(join(dir, "unrelated"), "x");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(checks).toHaveLength(1);
    expect(armedWatcherCount()).toBe(1);
});
