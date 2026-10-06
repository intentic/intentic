// Pins that the throwaway worktree a snapshot run checks out is taken back however the run ends (check-snapshot.mjs): a
// run killed at its deadline used to leave the worktree registered in the repository, and its directory under the temp dir.
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { sweepSnapshots } from "./check-snapshot.mjs";

const SNAPSHOT = fileURLToPath(new URL("./check-snapshot.mjs", import.meta.url));

// A repository with a stand-in checks runner that answers at once in the checkout, and hangs in a snapshot.
const repo = () => {
    const root = mkdtempSync(join(tmpdir(), "check-snapshot-test-"));
    const run = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
    run("init", "-q", "-b", "main");
    mkdirSync(join(root, "_tools/checks"), { recursive: true });
    writeFileSync(join(root, "_tools/checks/run.mjs"), `if (process.cwd().includes("verify-snapshot-")) await new Promise((resolve) => setTimeout(resolve, 60_000));\nprocess.stdout.write("[]");\n`);
    run("add", "-A");
    run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "base");
    return { root, run };
};

const snapshotsOf = (run) => run("worktree", "list", "--porcelain").split("\n").filter((line) => line.includes("verify-snapshot-"));

test("a snapshot older than the limit is taken back, a younger one is left", () => {
    const { root, run } = repo();
    const made = [];
    try {
        for (const name of ["old", "young"]) {
            const parent = mkdtempSync(join(tmpdir(), "verify-snapshot-"));
            made.push(parent);
            run("worktree", "add", "--detach", join(parent, "before"), "HEAD");
            if (name === "old") {
                utimesSync(parent, new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
            }
        }
        assert.equal(snapshotsOf(run).length, 2);
        assert.equal(sweepSnapshots(root), 1);
        assert.deepEqual(snapshotsOf(run).map((line) => line.replace("worktree ", "")), [join(made[1], "before")]);
        assert.equal(existsSync(made[0]), false);
        assert.equal(existsSync(made[1]), true);
    } finally {
        for (const parent of made) {
            rmSync(parent, { recursive: true, force: true });
        }
        rmSync(root, { recursive: true, force: true });
    }
});

test("a run killed with its checks leaves no snapshot behind", async () => {
    const { root, run } = repo();
    try {
        const script = `import { reportsAt } from ${JSON.stringify(SNAPSHOT)}; console.log(String(reportsAt(${JSON.stringify(root)}, "HEAD", ["x"])));`;
        // A group of its own, as the sandbox runs a check in, so the signal reaches the checks inside the run too.
        const child = spawn(process.execPath, ["--input-type=module", "-e", script], { detached: true, stdio: "ignore" });
        const ended = new Promise((resolve) => child.once("exit", resolve));
        for (let tries = 0; snapshotsOf(run).length === 0 && tries < 200; tries += 1) {
            await new Promise((resolve) => setTimeout(resolve, 50));
        }
        assert.equal(snapshotsOf(run).length, 1, "the run never took its snapshot");
        process.kill(-child.pid, "SIGTERM");
        await ended;
        assert.deepEqual(snapshotsOf(run), []);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
