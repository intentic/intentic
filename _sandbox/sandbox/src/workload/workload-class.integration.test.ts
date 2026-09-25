import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { getPriority } from "node:os";
import { type ChildProcess, spawn } from "node:child_process";
import { requires } from "@intentic/testing/requires";
import { applyToStampedChild, OOM_SCORE, SPAWN_STAMP_ENV, spawnAs } from "./workload-class.js";

/* The half the unit tests cannot reach: real children of this process, classed through procfs. A score that parses and
   never lands on a process looks exactly like one that did, so only the kernel's own file proves it. */

const SETTLE_MS = 5_000;
const POLL_MS = 50;

const scoreOf = async (pid: number): Promise<number> => Number((await readFile(`/proc/${String(pid)}/oom_score_adj`, "utf8")).trim());

// Waits for the file to read `wanted`, and returns what it last read, so a miss fails with the value it had.
const settledScore = async (pid: number, wanted: number): Promise<number> => {
    const deadline = Date.now() + SETTLE_MS;
    let last = await scoreOf(pid);
    while (last !== wanted && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        last = await scoreOf(pid);
    }
    return last;
};

const children: ChildProcess[] = [];

afterEach(() => {
    for (const child of children.splice(0)) {
        child.kill("SIGKILL");
    }
});

const kept = <T extends ChildProcess>(child: T): T => {
    children.push(child);
    return child;
};

// Children inherit this process's score and a class never lowers one, so only a class above it can be seen to land.
const INHERITED = process.platform === "linux" ? Number(readFileSync("/proc/self/oom_score_adj", "utf8").trim()) : 0;

// Only a rank above what this process inherited can be seen to land, and procfs is Linux's.
const kernel = requires(
    process.platform === "linux" && INHERITED < OOM_SCORE.heavy,
    `Linux, with this process ranked below the toolchain class (it inherited oom_score_adj ${String(INHERITED)})`,
);

describe.skipIf(!kernel.runs)(kernel.title("spawnAs puts a child in its class as it starts"), () => {
    test("the rank and niceness are on the child when spawn returns", async () => {
        // The toolchain class, the highest rank: whatever this runner inherited, a write that landed reads above it.
        const child = kept(spawnAs({ class: "toolchain" }, "sleep", ["31"], { stdio: "ignore" }));
        const pid = child.pid ?? 0;
        expect(await scoreOf(pid)).toBe(OOM_SCORE.heavy);
        expect(getPriority(pid)).toBe(19);
    });

    test("what the child forks after it started inherits the class", async () => {
        const shell = kept(spawnAs({ class: "toolchain" }, "sh", ["-c", "sleep 0.3; sleep 32 & wait"], { stdio: "ignore" }));
        const pid = shell.pid ?? 0;
        const deadline = Date.now() + SETTLE_MS;
        // The one forked a third of a second in, long after the class landed on the shell.
        let grandchild: number | undefined;
        while (grandchild === undefined && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            const pids = (await readFile(`/proc/${String(pid)}/task/${String(pid)}/children`, "utf8")).trim().split(/\s+/u).filter(Boolean);
            for (const candidate of pids) {
                // oxlint-disable-next-line eslint/no-await-in-loop -- one or two children.
                const argv = await readFile(`/proc/${candidate}/cmdline`, "utf8").catch(() => "");
                if (argv === "sleep\u000032\u0000") {
                    grandchild = Number(candidate);
                }
            }
        }
        expect(await scoreOf(grandchild ?? 0)).toBe(OOM_SCORE.heavy);
    });

    test("a child already ranked above its class keeps its own", async () => {
        const high = OOM_SCORE.heavy + 100;
        // choom execs sleep in place, so the pid is the sleeper's; a lower score written over it would read the class's.
        const ranked = kept(spawnAs({ class: "agentRuntime", spawnDepth: 0 }, "choom", ["-n", String(high), "--", "sleep", "33"], { stdio: "ignore" }));
        expect(await settledScore(ranked.pid ?? 0, high)).toBe(high);
    });

    // A library that spawns with no hook (the OpenCode SDK) hands back no pid; the stamp set across its spawn finds it.
    test("a child a library spawned is found by the stamp set across the spawn, and classed", async () => {
        const plain = kept(spawn("sleep", ["34"], { stdio: "ignore" }));
        const stamped = kept(spawn("sleep", ["34"], { stdio: "ignore", env: { ...process.env, [SPAWN_STAMP_ENV]: "stamp-1" } }));
        expect(applyToStampedChild("stamp-1", { class: "toolchain" })).toBe(stamped.pid);
        expect(await scoreOf(stamped.pid ?? 0)).toBe(OOM_SCORE.heavy);
        expect(await scoreOf(plain.pid ?? 0)).toBe(INHERITED);
        expect(applyToStampedChild("no-such-stamp", { class: "toolchain" })).toBeUndefined();
    });
});
