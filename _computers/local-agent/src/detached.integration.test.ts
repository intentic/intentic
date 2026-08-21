import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isProcessAlive, spawnDetached } from "./detached.js";

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
