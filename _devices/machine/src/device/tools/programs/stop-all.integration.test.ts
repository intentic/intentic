import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppRun } from "./programs.js";
import { stopAllApps } from "./stop-all.js";

/* `uninstall --purge` stops what `app_start` left running, from the records alone, as a new process that started none
   of it: a real program in its own process group, under a runs folder of the test's own (never the agent's). */

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        // allow(silent-catch): ESRCH is the answer "gone"
        return false;
    }
};

const record = (name: string, pid: number, extra: Partial<AppRun> = {}): AppRun => ({
    id: `${name}-abc123`,
    name,
    program: "/bin/sleep",
    args: ["600"],
    cwd: "/",
    pid,
    startedAt: new Date().toISOString(),
    log: "/dev/null",
    ...extra,
});

describe.skipIf(process.platform === "win32")("stopAllApps", () => {
    let root: string;

    beforeEach(async () => {
        root = await mkdtemp(join(tmpdir(), "stop-all-"));
    });

    afterEach(async () => {
        await rm(root, { recursive: true, force: true });
    });

    it("stops a run still going, and leaves alone one that ended and one whose program is gone", async () => {
        const child = spawn("sleep", ["600"], { detached: true, stdio: "ignore" });
        child.unref();
        const pid = child.pid ?? 0;
        // A pid that held a program once and holds none now: a child that already exited.
        const done = spawn("true", [], { stdio: "ignore" });
        await new Promise((resolve) => done.once("exit", resolve));
        await mkdir(join(root, "sandbox-ab12"), { recursive: true });
        await writeFile(
            join(root, "sandbox-ab12", "apps.json"),
            JSON.stringify([record("server", pid), record("ended", pid + 1, { endedAt: new Date().toISOString() }), record("gone", done.pid ?? 0)]),
        );
        const result = await stopAllApps(root);
        expect(result.stopped).toEqual(["server"]);
        expect(result.left).toEqual([]);
        expect(alive(pid)).toBe(false);
    });

    it("finds nothing to stop where no sandbox ever started a program", async () => {
        expect(await stopAllApps(join(root, "missing"))).toEqual({ stopped: [], left: [] });
    });
});
