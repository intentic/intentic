import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { jobRunnerPids } from "./job-processes.js";

// A /proc of its own: each process a directory with the cmdline and stat the real one would show.
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

const procWith = (processes: Record<number, { argv: string[]; parent: number; session: number }>): string => {
    const root = mkdtempSync(join(tmpdir(), "job-processes-"));
    roots.push(root);
    for (const [pid, { argv, parent, session }] of Object.entries(processes)) {
        mkdirSync(join(root, pid));
        writeFileSync(join(root, pid, "cmdline"), `${argv.join("\0")}\0`);
        writeFileSync(join(root, pid, "stat"), `${pid} (bash) S ${parent} ${session} ${session} 34816 ${session} 4194560 0 0 0 0 1 0 0 0 20 0 1 0`);
    }
    return root;
};

test("the runner is found by its command line, and a dir with no runner is absent", async () => {
    const proc = procWith({
        40: { argv: ["bash", "/tmp/job-a/runner"], parent: 1, session: 40 },
        41: { argv: ["cat", "/tmp/job-a/runner"], parent: 1, session: 1 },
    });
    expect(await jobRunnerPids(["/tmp/job-a", "/tmp/job-b"], proc)).toEqual(new Map([["/tmp/job-a", 40]]));
});

test("a fork of the runner about to exec its command is not taken for the runner, wherever it is listed", async () => {
    // The pipeline's two sides, forked and not yet exec'd, still carry the runner's argv: one listed before the
    // runner (a pid that wrapped) and one after.
    const proc = procWith({
        7: { argv: ["bash", "/tmp/job-a/runner"], parent: 500, session: 500 },
        500: { argv: ["bash", "/tmp/job-a/runner"], parent: 1, session: 500 },
        501: { argv: ["bash", "/tmp/job-a/runner"], parent: 500, session: 500 },
    });
    expect(await jobRunnerPids(["/tmp/job-a"], proc)).toEqual(new Map([["/tmp/job-a", 500]]));
});
