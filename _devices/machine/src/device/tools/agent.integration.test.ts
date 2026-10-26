import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { followLog, type LogFollowTiming } from "./agent.js";

/* FOLLOWING THE DETACHED RUN'S LOG (2026-10-20): its lines are read as they land (fs.watch), and once its pid is gone the
   follow ends when the log has gone quiet, the old fixed 1.5 s drain kept only as the cap. Short timings, real files. */

const FAST: LogFollowTiming = { aliveCheckMs: 10, drainQuietMs: 60, drainMaxMs: 400, fallbackReadMs: 5_000, timeoutMs: 5_000 };

test("lines are handed on as they land, only those after `from`, and the follow ends soon after the run is gone", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-log-"));
    try {
        const log = join(dir, "agent.log");
        await writeFile(log, "old line\n");
        const lines: { line: string; at: number }[] = [];
        let alive = true;
        const started = performance.now();
        setTimeout(() => void appendFile(log, "downloading\n"), 50);
        setTimeout(() => void appendFile(log, "installed\n"), 150);
        setTimeout(() => {
            alive = false;
        }, 200);
        await followLog({ path: log, from: "old line\n".length, isAlive: () => alive, onLine: (line) => lines.push({ line, at: performance.now() - started }), timing: FAST });
        expect(lines.map((entry) => entry.line)).toEqual(["downloading", "installed"]);
        // Heard by the watch, not the 5 s fallback read.
        expect(lines[0]?.at ?? Infinity).toBeLessThan(1_000);
        // Gone at 200 ms, quiet for 60: well before the drain cap would have ended it.
        expect(performance.now() - started).toBeLessThan(200 + FAST.drainMaxMs);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test("a log that keeps being written (the new agent) is cut off at the drain cap", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agent-log-"));
    try {
        const log = join(dir, "agent.log");
        await writeFile(log, "");
        const writer = setInterval(() => void appendFile(log, "tick\n"), 15);
        const started = performance.now();
        await followLog({ path: log, from: 0, isAlive: () => false, onLine: () => undefined, timing: FAST });
        clearInterval(writer);
        const took = performance.now() - started;
        expect(took).toBeGreaterThanOrEqual(FAST.drainMaxMs);
        expect(took).toBeLessThan(FAST.drainMaxMs + 500);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
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
        const writing = new Promise<void>((resolve, reject) => {
            setTimeout(() => void appendFile(log, "dated.\n").then(resolve, reject), 40);
        });
        await followLog({ path: log, from: 0, isAlive: () => false, onLine: (line) => lines.push(line), timing: FAST });
        await writing;
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
