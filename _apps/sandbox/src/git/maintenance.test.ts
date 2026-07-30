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

test("maintenance runs the incremental task set over the root repo and every nested one", async () => {
    const work = await setup();
    const calls: { dir: string; args: readonly string[] }[] = [];

    await runGitMaintenance(workspacePaths(work), logger, async (dir, args) => {
        calls.push({ dir, args });
        return { stdout: "", stderr: "" };
    });

    expect(calls.map((call) => call.dir)).toEqual([work, join(work, "intent")]);
    // The task list is a decision, not a default: `gc` is deliberately absent (it is the one task that can
    // stall a live turn), and every task named here is one --auto would have skipped or under-run.
    expect(calls[0]?.args).toEqual([
        "maintenance",
        "run",
        "--quiet",
        "--task=pack-refs",
        "--task=commit-graph",
        "--task=loose-objects",
        "--task=incremental-repack",
    ]);
});

test("a repo that cannot be maintained never stops the ones that can", async () => {
    const work = await setup();
    const reached: string[] = [];

    await runGitMaintenance(workspacePaths(work), logger, async (dir) => {
        reached.push(dir);
        if (dir === work) {
            throw new Error("fatal: not a git repository");
        }
        return { stdout: "", stderr: "" };
    });

    expect(reached).toEqual([work, join(work, "intent")]);
});
