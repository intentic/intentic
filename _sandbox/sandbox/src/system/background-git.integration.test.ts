import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { startPeriodic } from "@intentic/base/async";
import { defaultGit, gitRunCallers, UNLABELLED_GIT_CALLER, withGitCaller } from "@intentic/base/git";
import { createWorkspaceHistory } from "../history/history.js";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import { inBackground } from "./background-git.js";

// What used to be filed `unlabelled`: a loop's timer firing long after whoever started it returned. Started inside
// inBackground, every pass it runs is counted under the loop's own name, never under the request that happened to start
// it, and nothing of it is left unlabelled.

const exec = promisify(execFile);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const tempRepo = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-background-git-"));
    tempDirs.push(dir);
    await exec("git", ["-C", dir, "init", "-q"]);
    return dir;
};

const counted = (): ((caller: string) => number) => {
    const before = gitRunCallers();
    return (caller) => (gitRunCallers()[caller] ?? 0) - (before[caller] ?? 0);
};

test("every pass a background loop's timer runs is counted under the loop, not its starter nor unlabelled", async () => {
    const dir = await tempRepo();
    const delta = counted();
    let passes = 0;
    let twice = (): void => undefined;
    const ranTwice = new Promise<void>((resolve) => {
        twice = resolve;
    });
    // Started from inside a request, as a lazily started loop is: its passes are still the loop's.
    const loop = withGitCaller("http probe.route", () =>
        inBackground("probe-loop", () =>
            startPeriodic({
                warmupMs: 5,
                everyMs: 5,
                run: async () => {
                    await defaultGit(dir, ["rev-parse", "--git-dir"]);
                    passes += 1;
                    if (passes === 2) {
                        twice();
                    }
                },
            }),
        ),
    );
    await ranTwice;
    loop.dispose();
    expect(delta("bg probe-loop")).toBe(2);
    expect(delta("http probe.route")).toBe(0);
    expect(delta(UNLABELLED_GIT_CALLER)).toBe(0);
});

// The workspace history's sweep, twenty-odd git processes whenever anything moved, was the largest share of the
// daemon's unlabelled git (boot-schedulers.ts starts it this way).
test("the workspace history's sweep runs all of its git under its loop's name", async () => {
    const base = await mkdtemp(join(tmpdir(), "intentic-background-history-"));
    tempDirs.push(base);
    const work = join(base, "work");
    await mkdir(work, { recursive: true });
    await writeFile(join(work, "notes.md"), "one\n");
    const history = createWorkspaceHistory({ workspace: workspacePaths(work), historyRoot: join(base, "history"), logger });
    const delta = counted();
    inBackground("history", () => history.start());
    // Queued behind the sweep the start began, so the sweep has finished once this answers; its own git is the test's.
    await withGitCaller("probe.wait", () => history.snapshot("interval"));
    history.stop();
    expect(delta("bg history")).toBeGreaterThan(0);
    expect(delta(UNLABELLED_GIT_CALLER)).toBe(0);
});
