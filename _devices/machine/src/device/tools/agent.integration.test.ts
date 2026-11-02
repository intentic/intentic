import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { advanceTimersByTimeAsync, SETTLES, waitFor } from "@intentic/testing/bun";
import { followLog, type LogFollowTiming } from "./agent.js";

/* FOLLOWING THE DETACHED RUN'S LOG (2026-10-20): its lines are read as they land (fs.watch), and once its pid is gone the
   follow ends when the log has gone quiet, the old fixed 1.5 s drain kept only as the cap. Short timings, real files. */

const FAST: LogFollowTiming = { aliveCheckMs: 10, drainQuietMs: 60, drainMaxMs: 400, fallbackReadMs: 5_000, timeoutMs: 5_000 };

describe("log wake and drain boundaries", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.spyOn(performance, "now").mockImplementation(Date.now);
    });
    afterEach(() => {
        jest.restoreAllMocks();
        jest.useRealTimers();
    });

    test("file events deliver new lines and a quiet log ends after the run exits", async () => {
        const dir = await mkdtemp(join(tmpdir(), "agent-log-"));
        try {
            const log = join(dir, "agent.log");
            await writeFile(log, "old line\n");
            const lines: string[] = [];
            let alive = true;
            let looks = 0;
            let finished = false;
            const following = followLog({ path: log, from: Buffer.byteLength("old line\n"), isAlive: () => { looks += 1; return alive; }, onLine: (line) => lines.push(line), timing: FAST }).then(() => { finished = true; });
            await advanceTimersByTimeAsync(10);
            await waitFor(() => expect(looks).toBe(1), SETTLES);
            await appendFile(log, "downloading\n");
            // No clock advances: the watch must deliver this without the 5 s fallback.
            await waitFor(() => expect(lines).toEqual(["downloading"]), SETTLES);
            await advanceTimersByTimeAsync(20);
            await appendFile(log, "installed\n");
            await waitFor(() => expect(lines).toEqual(["downloading", "installed"]), SETTLES);
            alive = false;
            await advanceTimersByTimeAsync(10);
            await waitFor(() => expect(looks).toBe(4), SETTLES);
            await advanceTimersByTimeAsync(FAST.drainQuietMs - 1);
            expect(finished).toBe(false);
            await advanceTimersByTimeAsync(1);
            await following;
            expect(finished).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    test("the drain cap ends a follow even when the log has not gone quiet", async () => {
        const dir = await mkdtemp(join(tmpdir(), "agent-log-"));
        try {
            const log = join(dir, "agent.log");
            await writeFile(log, "");
            const lines: string[] = [];
            let looks = 0;
            let finished = false;
            const timing = { ...FAST, drainQuietMs: FAST.drainMaxMs + 500 };
            const following = followLog({ path: log, from: 0, isAlive: () => { looks += 1; return false; }, onLine: (line) => lines.push(line), timing }).then(() => { finished = true; });
            await advanceTimersByTimeAsync(10);
            await waitFor(() => expect(looks).toBe(1), SETTLES);
            await advanceTimersByTimeAsync(FAST.drainMaxMs - 1);
            await appendFile(log, "still writing\n");
            await waitFor(() => expect(lines).toEqual(["still writing"]), SETTLES);
            expect(finished).toBe(false);
            await advanceTimersByTimeAsync(1);
            await following;
            expect(finished).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

test("a log rotated before the run started is read from its start", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-log-"));
    try {
        const log = join(dir, "agent.log");
        await writeFile(log, "fresh\n");
        const lines: string[] = [];
        await followLog({ path: log, from: 10_000, isAlive: () => false, onLine: (line) => lines.push(line), timing: FAST });
        expect(lines).toEqual(["fresh"]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a line written in pieces is handed on whole", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-log-pieces-"));
    try {
        const log = join(dir, "agent.log");
        await writeFile(log, "error: The agent was not up");
        const lines: string[] = [];
        let alive = true;
        const following = followLog({ path: log, from: 0, isAlive: () => alive, onLine: (line) => lines.push(line), timing: FAST });
        await appendFile(log, "dated.\n");
        alive = false;
        await following;
        expect(lines).toEqual(["error: The agent was not updated."]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("the starting offset counts bytes in a log with non-ASCII history", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-log-utf8-"));
    try {
        const log = join(dir, "agent.log");
        const old = "previous: 日本語\n";
        await writeFile(log, `${old}error: failed\n`);
        const lines: string[] = [];
        await followLog({ path: log, from: Buffer.byteLength(old), isAlive: () => false, onLine: (line) => lines.push(line), timing: FAST });
        expect(lines).toEqual(["error: failed"]);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a read failure rejects the follow instead of escaping from its timer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-log-unreadable-"));
    try {
        await expect(followLog({ path: dir, from: 0, isAlive: () => true, onLine: () => undefined, timing: FAST })).rejects.toThrow();
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a failed line consumer rejects the follow instead of escaping from its timer", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-log-consumer-"));
    try {
        const log = join(dir, "agent.log");
        await writeFile(log, "line\n");
        const error = new Error("connection closed");
        await expect(followLog({ path: log, from: 0, isAlive: () => false, onLine: () => { throw error; }, timing: FAST })).rejects.toBe(error);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
