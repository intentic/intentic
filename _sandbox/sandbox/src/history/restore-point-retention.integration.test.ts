import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createWorkspaceHistory, type HistoryGitRunner } from "./history.js";

// Restore-point retention against real git: what is cut must leave the disk, and every point kept must still list,
// diff and restore. Commit times are set through git's own date variables, so a month of snapshots takes no waiting.

const exec = promisify(execFile);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

let base: string;
beforeEach(async () => {
    base = await mkdtemp(join(tmpdir(), "intentic-retention-"));
});
afterEach(async () => {
    await rm(base, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;
const START = Date.parse("2026-01-01T12:00:00Z");

// A runner whose commits are dated `clock.at`, as the history's own runner would date them at that moment.
const datedHistory = (work: string, historyRoot: string) => {
    const clock = { at: START };
    const git: HistoryGitRunner = async (args, options) => {
        const date = `${String(Math.floor(clock.at / 1000))} +0000`;
        const { stdout, stderr } = await exec("git", ["-c", "core.fileMode=true", ...args], {
            cwd: options.cwd,
            env: { ...process.env, ...options.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        });
        return { stdout, stderr };
    };
    return { clock, history: createWorkspaceHistory({ workspace: workspacePaths(work), historyRoot, logger }, git) };
};

// Whether a scope's object store still holds these bytes, packed or loose.
const holds = async (gitDir: string, content: string): Promise<boolean> => {
    const sha = await new Promise<string>((resolve, reject) => {
        const child = execFile("git", ["hash-object", "--stdin"], (error, out) => (error === null ? resolve(out.trim()) : reject(error)));
        child.stdin?.end(content);
    });
    return exec("git", ["--git-dir", gitDir, "cat-file", "-e", sha]).then(
        () => true,
        () => false,
    );
};

test("restore points before the cut leave the disk; the newest one before it stays hidden for the points after it", async () => {
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    await mkdir(work, { recursive: true });
    const { clock, history } = datedHistory(work, historyRoot);
    const gitDir = join(historyRoot, "scopes", "root.git");

    await writeFile(join(work, "a.txt"), "the oldest secret\n");
    await history.snapshot("turn", "first");
    clock.at = START + 4 * DAY;
    await writeFile(join(work, "a.txt"), "the state at the cut\n");
    await history.snapshot("turn", "second");
    clock.at = START + 9 * DAY;
    await writeFile(join(work, "b.txt"), "kept\n");
    const third = await history.snapshot("turn", "third");
    expect((await history.list()).map((snapshot) => snapshot.label)).toEqual(["third", "second", "first"]);

    // The first goes, the second becomes the hidden base.
    expect(await history.prune(START + 7 * DAY)).toBe(2);
    expect((await history.list()).map((snapshot) => snapshot.label)).toEqual(["third"]);
    expect(await holds(gitDir, "the oldest secret\n")).toBe(false);
    expect(await holds(gitDir, "the state at the cut\n")).toBe(true);
    expect((await readFile(join(gitDir, "shallow"), "utf8")).trim()).toMatch(/^[0-9a-f]{40}$/u);

    // A second run with the same cut finds nothing more.
    expect(await history.prune(START + 7 * DAY)).toBe(0);

    // The point kept still restores, and later snapshots still chain onto the cut timeline.
    await writeFile(join(work, "b.txt"), "changed\n");
    expect(await history.restore(third ?? "")).toBe(true);
    expect(await readFile(join(work, "b.txt"), "utf8")).toBe("kept\n");
    expect(await readFile(join(work, "a.txt"), "utf8")).toBe("the state at the cut\n");
    clock.at = START + 10 * DAY;
    await writeFile(join(work, "c.txt"), "later\n");
    await history.snapshot("turn", "fourth");
    expect((await history.list()).map(({ trigger, label }) => [trigger, label])).toEqual([
        ["turn", "fourth"],
        ["restore", undefined],
        ["pre-restore", undefined],
        ["turn", "third"],
    ]);
});

test("a deleted repo whose every restore point is past the cut is removed whole", async () => {
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const repo = join(work, "gone");
    await mkdir(repo, { recursive: true });
    await exec("git", ["-C", repo, "init", "-q"]);
    await writeFile(join(repo, "notes.txt"), "about somebody\n");
    const { clock, history } = datedHistory(work, historyRoot);
    await history.snapshot("turn", "with the repo");
    await rm(repo, { recursive: true, force: true });
    clock.at = START + 9 * DAY;
    await writeFile(join(work, "other.txt"), "x\n");
    await history.snapshot("turn", "without it");

    expect(await history.prune(START + 7 * DAY)).toBeGreaterThan(0);
    expect(existsSync(join(historyRoot, "scopes", "gone.git"))).toBe(false);
    expect((await history.list()).map((snapshot) => snapshot.label)).toEqual(["without it"]);
});

test("a cut before every restore point removes nothing", async () => {
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    await mkdir(work, { recursive: true });
    const { history } = datedHistory(work, historyRoot);
    await writeFile(join(work, "a.txt"), "x\n");
    await history.snapshot("turn", "only");
    expect(await history.prune(START - DAY)).toBe(0);
    expect(existsSync(join(historyRoot, "scopes", "root.git", "shallow"))).toBe(false);
    expect((await history.list()).map((snapshot) => snapshot.label)).toEqual(["only"]);
});
