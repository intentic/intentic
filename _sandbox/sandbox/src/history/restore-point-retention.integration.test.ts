import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createWorkspaceHistory, type HistoryGitRunner } from "./history.js";
import { RETENTION_GRACE_MS } from "./restore-point-retention.js";

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

// A runner whose commits are dated `clock.at`, as the history's own runner would date them at that moment. Collected
// with `--prune=now` unless a test asks for the real grace, since the objects here were all written a moment ago.
interface DatedOptions {
    readonly failFirstGc?: boolean;
    readonly graceMs?: number;
    // Called with each retention collection's arguments before it runs (not a snapshot's `gc --auto`); may hold it.
    readonly onGc?: (args: readonly string[], signal: AbortSignal | undefined) => Promise<void>;
    // Every non-gc call's options, to see which carry a signal.
    readonly calls?: { args: readonly string[]; signal: boolean }[];
}

const datedHistory = (work: string, historyRoot: string, { failFirstGc = false, graceMs = 0, onGc, calls }: DatedOptions = {}) => {
    const clock = { at: START };
    let failGc = failFirstGc;
    const git: HistoryGitRunner = async (args, options) => {
        calls?.push({ args, signal: options.signal !== undefined });
        if (args.some((arg) => arg.startsWith("--prune="))) {
            await onGc?.(args, options.signal);
            if (failGc) {
                failGc = false;
                throw new Error("collection interrupted");
            }
        }
        const date = `${String(Math.floor(clock.at / 1000))} +0000`;
        const { stdout, stderr } = await exec("git", ["-c", "core.fileMode=true", ...args], {
            cwd: options.cwd,
            env: { ...process.env, ...options.env, GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date },
        });
        return { stdout, stderr };
    };
    const history = createWorkspaceHistory({ workspace: workspacePaths(work), historyRoot, logger, retentionGraceMs: graceMs, now: () => clock.at }, git);
    return { clock, history };
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

test("an entirely old store keeps its newest snapshot visible and the current workspace intact", async () => {
    const work = join(base, "work");
    await mkdir(work, { recursive: true });
    const { clock, history } = datedHistory(work, join(base, "history"));
    await writeFile(join(work, "a.txt"), "old\n");
    await history.snapshot("turn", "old");
    clock.at += DAY;
    await writeFile(join(work, "a.txt"), "newest\n");
    const newest = await history.snapshot("turn", "newest");
    await writeFile(join(work, "a.txt"), "current unsnapshotted\n");
    expect(await history.prune(START + 40 * DAY)).toBe(1);
    expect((await history.list()).map(({ label }) => label)).toEqual(["newest"]);
    expect(await readFile(join(work, "a.txt"), "utf8")).toBe("current unsnapshotted\n");
    expect(await history.restore(newest ?? "")).toBe(true);
    expect(await readFile(join(work, "a.txt"), "utf8")).toBe("newest\n");
});

test("collection interrupted after the boundary is written is retried on the next pass", async () => {
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    await mkdir(work, { recursive: true });
    const { clock, history } = datedHistory(work, historyRoot, { failFirstGc: true });
    for (const [day, text] of [[0, "old"], [1, "base"], [40, "newest"]] as const) {
        clock.at = START + day * DAY;
        await writeFile(join(work, "a.txt"), `${text}\n`);
        await history.snapshot("turn", text);
    }
    const gitDir = join(historyRoot, "scopes", "root.git");
    // The cut stands (two points off the timeline) though its collection did not run.
    expect(await history.prune(START + 10 * DAY)).toBe(2);
    expect(existsSync(join(gitDir, "retention-gc-pending"))).toBe(true);
    expect(await holds(gitDir, "old\n")).toBe(true);
    expect(await history.prune(START + 10 * DAY)).toBe(0);
    expect(existsSync(join(gitDir, "retention-gc-pending"))).toBe(false);
    expect(await holds(gitDir, "old\n")).toBe(false);
    expect((await history.list()).map(({ label }) => label)).toEqual(["newest"]);
});

// Every file under a scope's object store dated `ms` in the past, as objects written that long ago would be.
const ageObjects = async (gitDir: string, ms: number): Promise<void> => {
    const at = new Date(Date.now() - ms);
    for (const entry of await readdir(join(gitDir, "objects"), { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            await utimes(join(entry.parentPath, entry.name), at, at);
        }
    }
};

test("with the real grace, a cut's objects leave the disk on the collection a grace after the first, which only loosens", async () => {
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    await mkdir(work, { recursive: true });
    const gcs: string[][] = [];
    const { clock, history } = datedHistory(work, historyRoot, { graceMs: RETENTION_GRACE_MS, onGc: async (args) => void gcs.push([...args]) });
    for (const [day, text] of [[0, "old"], [1, "base"], [40, "newest"]] as const) {
        clock.at = START + day * DAY;
        await writeFile(join(work, "a.txt"), `${text}\n`);
        await history.snapshot("turn", text);
    }
    const gitDir = join(historyRoot, "scopes", "root.git");
    const mark = join(gitDir, "retention-gc-pending");

    expect(await history.prune(START + 10 * DAY)).toBe(2);
    expect(gcs.at(-1)).toContain(`--prune=${String(RETENTION_GRACE_MS / 1000)}.seconds.ago`);
    // Written a moment ago, the cut's objects are inside the grace: kept for now, and the mark says a collection ran.
    expect(await holds(gitDir, "old\n")).toBe(true);
    expect((await readFile(mark, "utf8")).trim()).toBe(`gc ${String(clock.at)}`);
    expect((await history.list()).map(({ label }) => label)).toEqual(["newest"]);

    // Still inside the grace of that first collection: the mark stays, still naming it.
    clock.at += RETENTION_GRACE_MS / 2;
    const first = await readFile(mark, "utf8");
    expect(await history.prune(START + 10 * DAY)).toBe(0);
    expect(await readFile(mark, "utf8")).toBe(first);

    // A grace later, with everything the cut left older than the horizon: gone, and the mark with it.
    await ageObjects(gitDir, 2 * RETENTION_GRACE_MS);
    clock.at += RETENTION_GRACE_MS;
    expect(await history.prune(START + 10 * DAY)).toBe(0);
    expect(existsSync(mark)).toBe(false);
    expect(await holds(gitDir, "old\n")).toBe(false);
    expect(await holds(gitDir, "newest\n")).toBe(true);
    expect((await history.list()).map(({ label }) => label)).toEqual(["newest"]);
});

test("the collection runs outside the history lock, and only it carries the budget's signal", async () => {
    const work = join(base, "work");
    await mkdir(work, { recursive: true });
    let started!: () => void;
    const gcStarted = new Promise<void>((resolve) => {
        started = resolve;
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const calls: { args: readonly string[]; signal: boolean }[] = [];
    const { clock, history } = datedHistory(work, join(base, "history"), {
        calls,
        onGc: async () => {
            started();
            await held;
        },
    });
    for (const [day, text] of [[0, "old"], [1, "base"], [40, "newest"]] as const) {
        clock.at = START + day * DAY;
        await writeFile(join(work, "a.txt"), `${text}\n`);
        await history.snapshot("turn", text);
    }
    const pruning = history.prune(START + 10 * DAY);
    await gcStarted;
    // A snapshot (what every git action of the owner's takes first) is not held behind the gc.
    await writeFile(join(work, "a.txt"), "during the gc\n");
    expect(await history.snapshot("user", "during")).toEqual(expect.any(String));
    release();
    expect(await pruning).toBe(2);
    expect((await history.list()).map(({ label }) => label)).toEqual(["during", "newest"]);
    expect(calls.filter((call) => call.signal).map((call) => call.args.includes("gc"))).toEqual([true]);
});
