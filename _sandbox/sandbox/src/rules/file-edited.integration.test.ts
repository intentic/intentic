import { mkdtempSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getPriority, tmpdir } from "node:os";
import { join } from "node:path";
import { requires } from "@intentic/testing/requires";
import { OOM_SCORE } from "../workload/workload-class.js";
import { spawnEditCommand } from "./file-edited.js";

/* The default runner against real children: what the ceiling kills and what rank the line runs at are only seen in
   procfs, never in the runner's own answer. */

const SETTLE_MS = 5_000;
const POLL_MS = 50;

const scratch = (): string => mkdtempSync(join(tmpdir(), "file-edited-"));

// Gone, or a zombie no parent has reaped yet: either way nothing of it runs.
const ended = async (pid: number): Promise<boolean> => {
    const stat = await readFile(`/proc/${String(pid)}/stat`, "utf8").catch(() => "");
    return stat === "" || stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z");
};

const endedWithin = async (pid: number): Promise<boolean> => {
    const deadline = Date.now() + SETTLE_MS;
    while (!(await ended(pid)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
    return ended(pid);
};

const linux = requires(process.platform === "linux", "Linux, whose procfs shows what the ceiling left running");

describe.skipIf(!linux.runs)(linux.title("the ceiling ends the whole line"), () => {
    // Before, only the shell was killed: the sleep lived on, held the output pipe, and the edit waited the whole 31s.
    test("a check past its ceiling is an error, and what its shell started is killed with it", async () => {
        const cwd = scratch();

        const run = await spawnEditCommand(cwd)("sleep 31 & echo $! > child.pid; wait", 1_000);

        expect(run).toEqual({ status: "error", output: "did not finish within 1s" });
        const child = Number(readFileSync(join(cwd, "child.pid"), "utf8").trim());
        expect(await endedWithin(child)).toBe(true);
    });

    test("a check that finishes in time answers as before", async () => {
        expect(await spawnEditCommand(scratch())("echo clean", 10_000)).toEqual({ status: "passed", output: "clean\n" });
        expect(await spawnEditCommand(scratch())("echo 'no-unused-vars' >&2; exit 1", 10_000)).toEqual({ status: "failed", output: "no-unused-vars\n" });
    });
});

// Children inherit this process's rank and a class never lowers one, so only a class above it can be seen to land.
const INHERITED = process.platform === "linux" ? Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim()) : 0;
const kernel = requires(
    process.platform === "linux" && INHERITED < OOM_SCORE.command && getPriority() < 19,
    `Linux, with this process ranked below an agent's command (it inherited oom_score_adj ${String(INHERITED)}, niceness ${String(getPriority())})`,
);

describe.skipIf(!kernel.runs)(kernel.title("an edit check runs as an agent's command"), () => {
    // Read by the shell's own children a moment in, after the class has landed on the shell they forked from.
    test("its line is ranked for the OOM killer and niced like an agent's command, not like the daemon", async () => {
        const run = await spawnEditCommand(scratch())("sleep 0.2; nice; cat /proc/$$/oom_score_adj", 10_000);

        expect(run).toEqual({ status: "passed", output: `19\n${String(OOM_SCORE.command)}\n` });
    });
});
