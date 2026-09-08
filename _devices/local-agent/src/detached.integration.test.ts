import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessAlive, livePid, livePidRecord, pidFileBody, spawnDetached } from "./detached.js";

// Tests that a returned pid means something is actually running under it, not which spawn flags were used (the
// runtime's job).
const logFile = (): string => join(mkdtempSync(join(tmpdir(), "detached-")), "loop.log");

// A child that outlives the settle window without holding the test open longer than needed.
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

// A pidfile's pid means nothing outside its own boot: numbers restart low and get reused, so it's paired with a boot
// stamp.
describe("livePid", () => {
    const pidFile = (): string => join(mkdtempSync(join(tmpdir(), "pidfile-")), "agent.pid");

    // A live process, standing in for whoever holds a recycled pid after reboot.
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
        // Kill is not awaited; poll briefly until the process table catches up.
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

    // The note says which build wrote the file: swapping the binary doesn't change what a running process already
    // reports of itself.
    it("carries back the note the writer stamped beside the pid", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, await pidFileBody(pid, "1.233.0"));

            expect(await livePidRecord(path)).toEqual({ pid, note: "1.233.0" });
        } finally {
            stop();
        }
    });

    // A record without a note isn't broken: it's what an agent too old to stamp its build looks like to a reader.
    it("answers a record with no note at all", async () => {
        const path = pidFile();
        const { pid, stop } = alive();
        try {
            writeFileSync(path, await pidFileBody(pid));

            expect(await livePidRecord(path)).toEqual({ pid });
        } finally {
            stop();
        }
    });
});
