import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import { runGitMaintenance } from "./maintenance.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace root with one nested repo — enough to prove the pass reaches BOTH, which is the whole of its job.
const setup = async (): Promise<string> => {
    const work = await mkdtemp(join(tmpdir(), "intentic-maintenance-"));
    tempDirs.push(work);
    await mkdir(join(work, "intent"), { recursive: true });
    await writeFile(join(work, "intent", ".git"), "gitdir: /history/gits/intent\n");
    return work;
};

// A repo that already holds a pack, so incremental-repack's precondition is met and the full set runs.
const packed = { stdout: "count: 0\nsize: 0\nin-pack: 3\npacks: 1\n", stderr: "" };
const taskOf = (args: readonly string[]): string => String(args[3]);
const ALL_TASKS = ["--task=pack-refs", "--task=commit-graph", "--task=loose-objects", "--task=incremental-repack"];

test("maintenance runs the incremental task set over the root repo and every nested one", async () => {
    const work = await setup();
    const calls: { dir: string; args: readonly string[] }[] = [];

    await runGitMaintenance(workspacePaths(work), logger, async (dir, args) => {
        calls.push({ dir, args });
        return packed;
    });

    const maintenance = calls.filter((call) => call.args[0] === "maintenance");
    expect([...new Set(maintenance.map((call) => call.dir))]).toEqual([work, join(work, "intent")]);
    // ONE TASK PER INVOCATION, in this order: git runs a multi-`--task` command in REVERSE of the order given,
    // which put incremental-repack ahead of the loose-objects pass that gives it a pack to index at all. The
    // list itself is a decision too — `gc` is deliberately absent (it is the one task that can stall a live
    // turn), and every task named here is one --auto would have skipped or under-run.
    expect(maintenance.filter((call) => call.dir === work).map((call) => call.args)).toEqual(
        ALL_TASKS.map((task) => ["maintenance", "run", "--quiet", task]),
    );
});

test("a repo with no packs is never asked to write a multi-pack-index", async () => {
    const work = await setup();
    const ran: string[] = [];

    // What a freshly `git init`-ed repo reports: no objects at all, so loose-objects mints no pack either and
    // incremental-repack would fail with "no pack files to index" on this and every later sweep.
    await runGitMaintenance(workspacePaths(work), logger, async (_dir, args) => {
        if (args[0] === "count-objects") {
            return { stdout: "count: 0\nsize: 0\nin-pack: 0\npacks: 0\n", stderr: "" };
        }
        ran.push(taskOf(args));
        return { stdout: "", stderr: "" };
    });

    expect(ran).not.toContain("--task=incremental-repack");
    expect(ran).toEqual([...ALL_TASKS.slice(0, 3), ...ALL_TASKS.slice(0, 3)]);
});

test("a repo that cannot be maintained never stops the ones that can", async () => {
    const work = await setup();
    const ran: string[] = [];

    await runGitMaintenance(workspacePaths(work), logger, async (dir, args) => {
        // The root repo is unreachable in every way, including the precondition read for incremental-repack.
        if (dir === work) {
            throw new Error("fatal: not a git repository");
        }
        if (args[0] === "count-objects") {
            return packed;
        }
        ran.push(taskOf(args));
        return { stdout: "", stderr: "" };
    });

    expect(ran).toEqual(ALL_TASKS);
});

test("one failing task costs only itself", async () => {
    const work = await setup();
    const ran: string[] = [];

    await runGitMaintenance(workspacePaths(work), logger, async (_dir, args) => {
        if (args[0] === "count-objects") {
            return packed;
        }
        if (taskOf(args) === "--task=commit-graph") {
            throw new Error("error: task 'commit-graph' failed");
        }
        ran.push(taskOf(args));
        return { stdout: "", stderr: "" };
    });

    const withoutCommitGraph = ALL_TASKS.filter((task) => task !== "--task=commit-graph");
    expect(ran).toEqual([...withoutCommitGraph, ...withoutCommitGraph]);
});
