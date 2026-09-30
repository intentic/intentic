import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pollUntil } from "@intentic/base/async";
import { requires } from "@intentic/testing/requires";
import { runIc } from "./sandboxes.js";

/* A background round's deadline over a real child: an `ic` that never finishes (what a Docker Desktop that never comes
   up looks like from here) is stopped with everything it started, and the run says so. HOME points at a temp dir holding
   a fake `ic` where the agent looks first (~/.intentic/ic/bin/ic), answering `--version` like the real one so nothing is
   fetched. */

const posix = requires(process.platform !== "win32", "POSIX process groups");

let home: string;
const HOME_BEFORE = process.env["HOME"];

beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "intentic-machine-deadline-"));
    process.env["HOME"] = home;
    const bin = join(home, ".intentic", "ic", "bin");
    await mkdir(bin, { recursive: true });
    // Prints a progress line, starts a child that would outlive it, records that child's pid, and waits forever.
    const script = [
        "#!/bin/sh",
        'if [ "$1" = "--version" ]; then echo "ic 0.0.0"; exit 0; fi',
        'echo \'intentic-fix: {"report":{"stage":"fixing","doing":"Starting Docker Desktop","checks":[]}}\'',
        "sleep 600 &",
        `echo $! > "${join(home, "child.pid")}"`,
        "wait",
    ].join("\n");
    await writeFile(join(bin, "ic"), `${script}\n`);
    await chmod(join(bin, "ic"), 0o755);
});

afterAll(async () => {
    process.env["HOME"] = HOME_BEFORE;
    await rm(home, { recursive: true, force: true });
});

const alive = (pid: number): boolean => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        // allow(silent-catch): ESRCH is the answer: no such process
        return false;
    }
};

test.skipIf(!posix.runs)(posix.title("a run past its deadline is stopped with the children it started, and says so"), async () => {
    const lines: string[] = [];
    const run = await runIc(["sandbox", "fix", "--auto", "--json"], (line) => lines.push(line), {}, { deadlineMs: 1_000 });
    expect(run.timedOut).toBe(true);
    expect(run.code).toBe(1);
    expect(lines).toEqual(['intentic-fix: {"report":{"stage":"fixing","doing":"Starting Docker Desktop","checks":[]}}']);
    expect(run.output.split("\n").at(-1)).toBe("ic did not finish within 1 second and was stopped.");
    const child = Number((await readFile(join(home, "child.pid"), "utf8")).trim());
    // The group got SIGTERM with ic: its `sleep` goes too, within moments rather than at the ten-second SIGKILL.
    expect(await pollUntil(() => !alive(child), { intervalMs: 50, timeoutMs: 5_000 })).toBe(true);
});

test.skipIf(!posix.runs)(posix.title("a run with no deadline is never stopped by one"), async () => {
    const run = await runIc(["--version"], () => undefined);
    expect(run).toEqual({ code: 0, output: "ic 0.0.0" });
});
