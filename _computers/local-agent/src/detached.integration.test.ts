import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessAlive, livePid, pidFileBody, spawnDetached } from "./detached.js";

/* The contract these cover is the one a user reads as a sentence: "connected in the background (pid N)". It was
 * false on Windows for every release that spawned the loop without `detached`: the pid was real, the process
 * was already gone, and the caller had no way to tell. So the test is not "which flags does it pass" (the flags
 * are the runtime's business and the reason they are right is measured, not asserted) but "does it hand back a
 * pid only when something is still running under it". */
const logFile = (): string => join(mkdtempSync(join(tmpdir(), "detached-")), "loop.log");

// A child that outlives the settle window without holding the test open any longer than it must.
const stayAlive = ["-e", "setTimeout(() => {}, 10_000)"];

describe("spawnDetached", () => {
    it("answers the pid of a loop that is still running, and writes its output to the log", async () => {
        const log = logFile();
        const pid = await spawnDetached(log, [process.execPath], ["-e", "console.log('up'); setTimeout(() => {}, 10_000)"]);

        expect(isProcessAlive(pid)).toBe(true);
        expect(readFileSync(log, "utf8")).toContain("up");
        process.kill(pid);
    });

    it("refuses to report a loop that died on startup, and names the log that says why", async () => {
        const log = logFile();

        await expect(spawnDetached(log, [process.execPath], ["-e", "console.error('boom'); process.exit(1)"])).rejects.toThrow(log);
        expect(readFileSync(log, "utf8")).toContain("boom");
    });

    it("detaches the loop from the caller, so it is still there once the caller is done with it", async () => {
        const pid = await spawnDetached(logFile(), [process.execPath], stayAlive);

        expect(isProcessAlive(pid)).toBe(true);
        process.kill(pid);
    });
});

/* WHAT A PID CANNOT SAY ON ITS OWN. A pidfile lives beside the agent's config, so it outlives the boot that
 * wrote it, while the number in it means nothing outside the process table of that boot: pids restart low and
 * are handed out in roughly the same order every time, so a loop's own pid from yesterday is somebody else's
 * transient process this morning.
 *
 * Field failure, 2026-08-29, and the reason the boot stamp exists: a machine bugchecked in standby, so nothing
 * ran the path that removes the pidfile. It still said 232. The sync watcher came back as pid 216, probed 232,
 * found an unrelated early-boot process wearing it, and refused to start. Refusing is a CHOICE, so it exits 0 by
 * design (a supervisor must not restart a watcher into refusing again every RestartSec), which is exactly why
 * `Restart=on-failure` never fired and desktop file sync stayed off until a person went looking. */
describe("livePid", () => {
    const pidFile = (): string => join(mkdtempSync(join(tmpdir(), "pidfile-")), "agent.pid");

    // A live process, standing in for whoever holds the recycled number after a reboot.
    const alive = (): { pid: number; stop: () => void } => {
        const child = spawn(process.execPath, stayAlive, { detached: true, stdio: "ignore" });
        if (child.pid === undefined) {
            throw new Error("the stand-in process didn't start");
        }
        return { pid: child.pid, stop: () => void child.kill("SIGKILL") };
    };

    it("answers the pid of a loop this boot wrote down and is still running", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, await pidFileBody(pid));

            expect(await livePid(path)).toBe(pid);
        } finally {
            stop();
        }
    });

    it("ignores a record from another boot, however alive that pid happens to be now", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, `${pid} id:0f9a1c3e-0000-4000-8000-000000000000`);

            expect(await livePid(path)).toBeUndefined();
        } finally {
            stop();
        }
    });

    it("ignores a pid this boot wrote down that has since exited", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        writeFileSync(path, await pidFileBody(pid));
        stop();
        // The kill is delivered, not awaited: give the process table a moment to catch up before probing it.
        for (let waited = 0; waited < 2_000 && isProcessAlive(pid); waited += 50) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }

        expect(await livePid(path)).toBeUndefined();
    });

    it("ignores a file that is missing, empty or half-written", async () => {
        const path = pidFile();

        expect(await livePid(path)).toBeUndefined();
        writeFileSync(path, "");
        expect(await livePid(path)).toBeUndefined();
        writeFileSync(path, "not-a-pid id:abc");
        expect(await livePid(path)).toBeUndefined();
    });
});
