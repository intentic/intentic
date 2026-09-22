import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "bun:test";
import { waitFor } from "@intentic/testing/bun";
import {
    claimPidFile,
    holdPidFile,
    isProcessAlive,
    livePid,
    livePidRecord,
    LOG_ROTATE_BYTES,
    pidFileBody,
    releasePidFile,
    rotateIfLarge,
    spawnDetached,
    spawnThroughStub,
} from "./detached.js";

// Tests that a returned pid means something is actually running under it, not which spawn flags were used (the
// runtime's job).
const logFile = (): string => join(mkdtempSync(join(tmpdir(), "detached-")), "agent.log");

// A child that outlives the settle window without holding the test open longer than needed.
const stayAlive = ["-e", "setTimeout(() => {}, 10_000)"];

// A live process, standing in for whoever holds a recycled pid after reboot.
const alive = (): { pid: number; stop: () => void } => {
    const child = spawn(process.execPath, stayAlive, { detached: true, stdio: "ignore" });
    if (child.pid === undefined) {
        throw new Error("the stand-in process didn't start");
    }
    return { pid: child.pid, stop: () => void child.kill("SIGKILL") };
};

// Kill is not awaited; poll briefly until the process table catches up.
const gone = async (pid: number): Promise<void> => {
    for (let waited = 0; waited < 2_000 && isProcessAlive(pid); waited += 50) {
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
};

describe("spawnDetached", () => {
    it("answers the pid of an agent that is still running, and writes its output to the log", async () => {
        const log = logFile();
        const pid = await spawnDetached(log, [process.execPath], ["-e", "console.log('up'); setTimeout(() => {}, 10_000)"]);

        expect(isProcessAlive(pid)).toBe(true);
        expect(readFileSync(log, "utf8")).toContain("up");
        process.kill(pid);
    });

    it("refuses to report an agent that died on startup, and names the log that says why", async () => {
        const log = logFile();

        await expect(spawnDetached(log, [process.execPath], ["-e", "console.error('boom'); process.exit(1)"])).rejects.toThrow(log);
        expect(readFileSync(log, "utf8")).toContain("boom");
    });

    // A detached child that is a TASK rather than a agent: `device forget-unreachable` with nothing to drop prints one
    // line and exits, well inside the settle window, and the caller that asked for it must read that as done.
    it("answers for a child that was meant to finish, even when it finishes at once", async () => {
        const log = logFile();

        const pid = await spawnDetached(log, [process.execPath], ["-e", "console.log('dropped nothing')"], { finishes: true });

        // Answered without waiting the window out, which is the whole point; the child's own line lands right after.
        expect(pid).toBeGreaterThan(0);
        await waitFor(() => expect(readFileSync(log, "utf8")).toContain("dropped nothing"), { timeout: 5_000 });
    });

    it("detaches the agent from the caller, so it is still there once the caller is done with it", async () => {
        const pid = await spawnDetached(logFile(), [process.execPath], stayAlive);

        expect(isProcessAlive(pid)).toBe(true);
        process.kill(pid);
    });
});

// A resident agent appends to one file for as long as the machine is up, and one measured in the field had reached
// 7 MB. Rolled HERE, at the open, because the running agent writes through a handle its parent opened: renaming the
// path from inside would move a name nothing is writing to any more.
describe("rotateIfLarge", () => {
    it("sets the log aside once it is too big, keeping exactly one rollover", async () => {
        const log = logFile();
        writeFileSync(log, "x".repeat(LOG_ROTATE_BYTES));

        await rotateIfLarge(log);

        expect(existsSync(log)).toBe(false);
        expect(statSync(`${log}.1`).size).toBe(LOG_ROTATE_BYTES);
    });

    it("leaves a log that is still small alone, so a restart does not cost the run before it", async () => {
        const log = logFile();
        writeFileSync(log, "still readable");

        await rotateIfLarge(log);

        expect(readFileSync(log, "utf8")).toBe("still readable");
        expect(existsSync(`${log}.1`)).toBe(false);
    });

    // Called on the way into starting the agent, so it owes the caller nothing: a log with no directory, no
    // permission, or nothing there at all must not be able to stop the thing that writes it from running.
    it("says nothing about a log that is not there", async () => {
        await expect(rotateIfLarge(join(tmpdir(), "no-such-dir-for-rotation", "agent.log"))).resolves.toBeUndefined();
    });
});

/* The stub path, which only Windows takes in production. */
describe.skipIf(process.platform === "win32")("spawnThroughStub", () => {
    const stubFile = (body: string): string => {
        const stub = join(mkdtempSync(join(tmpdir(), "stub-")), "launch.sh");
        writeFileSync(stub, body);
        chmodSync(stub, 0o755);
        return stub;
    };

    // Starts a child that inherits its stdout and stderr, prints that child's pid, exits at once: intentic-launch.exe,
    // in the two lines of it that this function has to survive.
    const stubThatLeaksItsPipes = (): string => stubFile("#!/bin/sh\nsleep 30 &\necho $!\n");

    it("answers as soon as the stub prints the pid, without waiting on the agent that holds its pipes open", async () => {
        const started = Date.now();
        const pid = await spawnThroughStub(stubThatLeaksItsPipes(), logFile(), [process.execPath], stayAlive);

        expect(isProcessAlive(pid)).toBe(true);
        // The agent's own lifetime (30s here, unbounded in production) must not be in this number.
        expect(Date.now() - started).toBeLessThan(5_000);
        process.kill(pid);
    });

    // The other half of the same rewrite: with the pid line as the success signal, a stub that fails has to be heard
    // through its exit code instead — and its stderr is the only place that says why.
    it("blames a stub that exits in failure with what it said on stderr", async () => {
        const stub = stubFile("#!/bin/sh\necho 'no such program' >&2\nexit 1\n");

        await expect(spawnThroughStub(stub, logFile(), [process.execPath], stayAlive)).rejects.toThrow("no such program");
    });
});

// A pidfile's pid means nothing outside its own boot: numbers restart low and get reused, so it's paired with a boot
// stamp.
describe("livePid", () => {
    const pidFile = (): string => join(mkdtempSync(join(tmpdir(), "pidfile-")), "agent.pid");

    it("answers the pid of an agent this boot wrote down and is still running", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, await pidFileBody({ pid }));

            expect(await livePid(path)).toBe(pid);
        } finally {
            stop();
        }
    });

    it("ignores a record from another boot, however alive that pid happens to be now", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, JSON.stringify({ pid, boot: "id:0f9a1c3e-0000-4000-8000-000000000000" }));

            expect(await livePid(path)).toBeUndefined();
        } finally {
            stop();
        }
    });

    it("ignores a pid this boot wrote down that has since exited", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        writeFileSync(path, await pidFileBody({ pid }));
        stop();
        await gone(pid);

        expect(await livePid(path)).toBeUndefined();
    });

    it("ignores a file that is missing, empty or half-written", async () => {
        const path = pidFile();

        expect(await livePid(path)).toBeUndefined();
        writeFileSync(path, "");
        expect(await livePid(path)).toBeUndefined();
        writeFileSync(path, `{"pid":`);
        expect(await livePid(path)).toBeUndefined();
    });

    // Only the running process knows which build it is and who restarts it; replacing the binary changes neither.
    it("carries back the build and the supervisor the writer stamped", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, await pidFileBody({ pid, build: "1.233.0", supervisor: "windows" }));

            expect(await livePidRecord(path)).toEqual({ pid, build: "1.233.0", supervisor: "windows" });
        } finally {
            stop();
        }
    });

    it("answers a record that stamped nothing but its pid", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, await pidFileBody({ pid }));

            expect(await livePidRecord(path)).toEqual({ pid });
        } finally {
            stop();
        }
    });
});

// Two starters racing for one pidfile must never both keep it: two agents tear down each other's sessions.
describe("claimPidFile", () => {
    const home = (): { dir: string; path: string } => {
        const dir = mkdtempSync(join(tmpdir(), "claim-"));
        return { dir, path: join(dir, "agent.pid") };
    };

    it("claims a file nobody holds", async () => {
        const { dir, path } = home();

        expect(await claimPidFile(path, dir, { pid: process.pid, build: "1.0.0" })).toEqual({ claimed: true });
        expect(await livePidRecord(path)).toEqual({ pid: process.pid, build: "1.0.0" });
    });

    it("leaves a live holder alone and names it", async () => {
        const { dir, path } = home();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, await pidFileBody({ pid }));

            expect(await claimPidFile(path, dir, { pid: process.pid })).toEqual({ claimed: false, holder: { pid } });
        } finally {
            stop();
        }
    });

    it("takes over the record of a holder that has exited", async () => {
        const { dir, path } = home();
        const { pid, stop } = alive();
        writeFileSync(path, await pidFileBody({ pid }));
        stop();
        await gone(pid);

        expect(await claimPidFile(path, dir, { pid: process.pid })).toEqual({ claimed: true });
    });

    // The race itself: whoever wrote last owns the file, and the other learns it from its own re-read.
    it("hands a concurrent pair exactly one winner", async () => {
        const { dir, path } = home();
        const rival = alive();
        try {
            const [ours, theirs] = await Promise.all([
                claimPidFile(path, dir, { pid: process.pid }),
                claimPidFile(path, dir, { pid: rival.pid }),
            ]);

            expect([ours.claimed, theirs.claimed].filter(Boolean)).toHaveLength(1);
        } finally {
            rival.stop();
        }
    });
});

describe("holdPidFile", () => {
    const home = (): { dir: string; path: string } => {
        const dir = mkdtempSync(join(tmpdir(), "hold-"));
        return { dir, path: join(dir, "agent.pid") };
    };

    // A stopper's cleanup or a tidied directory is not a reason to give up the claim.
    it("writes a vanished claim back and keeps it", async () => {
        const { dir, path } = home();

        expect(await holdPidFile(path, dir, { pid: process.pid, build: "1.0.0" })).toBe(true);
        expect(await livePidRecord(path)).toEqual({ pid: process.pid, build: "1.0.0" });
    });

    it("reports the claim lost when another live process holds it", async () => {
        const { dir, path } = home();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, await pidFileBody({ pid }));

            expect(await holdPidFile(path, dir, { pid: process.pid })).toBe(false);
        } finally {
            stop();
        }
    });
});

describe("releasePidFile", () => {
    it("removes the file while it names the stopped pid", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "release-")), "agent.pid");
        writeFileSync(path, await pidFileBody({ pid: 4242 }));

        expect(await releasePidFile(path, 4242)).toBe(true);
        expect(existsSync(path)).toBe(false);
    });

    // A supervisor may already have started the replacement: its claim is not the stopper's to delete.
    it("leaves the claim of whoever replaced it", async () => {
        const path = join(mkdtempSync(join(tmpdir(), "release-")), "agent.pid");
        writeFileSync(path, await pidFileBody({ pid: 4343 }));

        expect(await releasePidFile(path, 4242)).toBe(false);
        expect(existsSync(path)).toBe(true);
    });
});
