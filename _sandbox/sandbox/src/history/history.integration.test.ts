import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { createLogger } from "../logger.js";
import { workspacePaths } from "../workspace/workspace.js";
import { createWorkspaceHistory, type HistoryGitRunner, repoGitDir } from "./history.js";

const exec = promisify(execFile);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

const tempDirs: string[] = [];
const tempBase = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-history-"));
    tempDirs.push(dir);
    return dir;
};
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// The first arg that isn't a -c config pair — the git subcommand a recorded call ran.
const subcommand = (args: readonly string[]): string => {
    for (let index = 0; index < args.length; index++) {
        if (args[index] === "-c") {
            index++;
            continue;
        }
        return args[index] ?? "";
    }
    return "";
};

// A root-scope-only history over a fake git that models refs/snapshots/head + commit trees in memory. The
// scope git dir is pre-created so ensureScope skips `init --bare` (the fake creates no real dirs).
const fakeHistory = async () => {
    const base = await tempBase();
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    await mkdir(work, { recursive: true });
    await mkdir(join(historyRoot, "scopes", "root.git", "info"), { recursive: true });

    const calls: string[][] = [];
    let head: string | undefined;
    let tree = "tree-1";
    let commits = 0;
    const trees = new Map<string, string>();
    const git: HistoryGitRunner = async (args) => {
        calls.push([...args]);
        const out = (stdout: string) => ({ stdout, stderr: "" });
        switch (subcommand(args)) {
            case "write-tree":
                return out(`${tree}\n`);
            case "rev-parse": {
                const rev = args.at(-1) ?? "";
                if (rev === "refs/snapshots/head") {
                    if (head === undefined) {
                        throw new Error("unknown ref");
                    }
                    return out(`${head}\n`);
                }
                const resolved = trees.get(rev.replace("^{tree}", "").replace("^", ""));
                if (resolved === undefined) {
                    throw new Error("unknown rev");
                }
                return out(`${resolved}\n`);
            }
            case "commit-tree": {
                const sha = `c${++commits}`;
                trees.set(sha, args[args.indexOf("commit-tree") + 1] ?? "");
                return out(`${sha}\n`);
            }
            case "update-ref":
                head = args.at(-1);
                return out("");
            case "log":
                if (head === undefined) {
                    throw new Error("unknown ref");
                }
                // -z record: sha␟seconds␟subject␟body, NUL-terminated.
                return out(`${head}\x1f1000\x1fsnapshot snap-1 turn\x1f\0`);
            default:
                return out("");
        }
    };
    const history = createWorkspaceHistory({ workspace: workspacePaths(work), historyRoot, logger }, git);
    return { history, calls, setTree: (next: string) => (tree = next) };
};

test("snapshot commits parentless first, skips an unchanged tree, then parents on the previous snapshot", async () => {
    const { history, calls, setTree } = await fakeHistory();

    const first = await history.snapshot("turn");
    expect(first).toBeDefined();
    const commitCalls = () => calls.filter((call) => call.includes("commit-tree"));
    expect(commitCalls()).toHaveLength(1);
    expect(commitCalls()[0]).not.toContain("-p");
    expect(commitCalls()[0]?.join(" ")).toContain(`snapshot ${first} turn`);
    expect(calls.some((call) => call.includes("update-ref") && call.includes("refs/snapshots/head") && call.includes("c1"))).toBe(true);

    // Same tree ⇒ no commit, no id.
    expect(await history.snapshot("interval")).toBeUndefined();
    expect(commitCalls()).toHaveLength(1);

    setTree("tree-2");
    expect(await history.snapshot("interval")).toBeDefined();
    expect(commitCalls()).toHaveLength(2);
    expect(commitCalls()[1]?.join(" ")).toContain("-p c1");
});

test("groups are cached between reads and recomputed only after a changed snapshot", async () => {
    const { history, calls, setTree } = await fakeHistory();
    await history.snapshot("turn");
    const logCount = () => calls.filter((call) => subcommand(call) === "log").length;

    // First read computes groups once (one `git log` per known scope — here just root).
    await history.list();
    const afterFirst = logCount();
    expect(afterFirst).toBe(1);

    // Repeated reads hit the cache: no extra `git log`, even across list/diff/fileDiff.
    await history.list();
    await history.diff("snap-1");
    await history.fileDiff("snap-1", "root", "hello.txt");
    expect(logCount()).toBe(afterFirst);

    // A snapshot that changes the tree invalidates the cache; the next read re-runs `git log`.
    setTree("tree-2");
    expect(await history.snapshot("interval")).toBeDefined();
    await history.list();
    expect(logCount()).toBe(afterFirst + 1);
});

test("notifyUserWrite debounces a burst of pings into ONE user-triggered snapshot", async () => {
    const { history, calls } = await fakeHistory();
    // Fake timers only to fire the debounce deterministically; the snapshot chain itself awaits real fs IO, so
    // restore real timers and use a follow-up snapshot as the serialization barrier (it skips — same tree).
    vi.useFakeTimers();
    try {
        history.notifyUserWrite();
        history.notifyUserWrite();
        history.notifyUserWrite();
        await vi.advanceTimersByTimeAsync(2_100);
    } finally {
        vi.useRealTimers();
    }
    await history.snapshot("interval");
    const commits = calls.filter((call) => call.includes("commit-tree"));
    expect(commits).toHaveLength(1);
    expect(commits[0]?.join(" ")).toMatch(/snapshot \S+ user/);
});

test("restore runs read-tree → clean → checkout-index in order, with a safety snapshot first", async () => {
    const { history, calls } = await fakeHistory();
    await history.snapshot("turn");
    calls.length = 0;

    expect(await history.restore("snap-1")).toBe(true);
    const order = calls.map(subcommand);
    const readTree = order.indexOf("read-tree");
    expect(order.indexOf("add")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("add")).toBeLessThan(readTree);
    expect(readTree).toBeLessThan(order.indexOf("clean"));
    expect(order.indexOf("clean")).toBeLessThan(order.indexOf("checkout-index"));

    expect(await history.restore("nope")).toBe(false);
});

test("repoGitDir derives the protected git dir path, URI-encoding nested ids", () => {
    expect(repoGitDir("/history", "intent")).toBe("/history/gits/intent");
    expect(repoGitDir("/history", "clients/foo")).toBe("/history/gits/clients%2Ffoo");
});

// End-to-end over a REAL git: snapshot → mutate (root file, new file, nested-repo edit, secret) → snapshot →
// diff → fileDiff → restore, asserting secrets stay out of history and the nested repo's own git is untouched.
test("integration: snapshot, diff, and restore a workspace with a nested repo and secrets", async () => {
    const base = await tempBase();
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const intent = join(work, "intent");
    await mkdir(intent, { recursive: true });
    await writeFile(join(work, "hello.txt"), "one\n");
    await writeFile(join(work, ".env"), "SECRET=x\n");
    await writeFile(join(intent, "deploy.config.ts"), "v1\n");

    // A real nested repo with its own commit; the agent's branch/HEAD must survive everything below.
    const sh = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
    await sh(intent, "init", "-q");
    await sh(intent, "add", "-A");
    await sh(intent, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
    const nestedHead = await sh(intent, "rev-parse", "HEAD");

    const history = createWorkspaceHistory({ workspace: workspacePaths(work), historyRoot, logger });
    const first = await history.snapshot("user");
    expect(first).toBeDefined();

    // A hidden interval capture lands between the two visible checkpoints — the turn's diff must span it.
    await writeFile(join(work, "hello.txt"), "two\n");
    const hidden = await history.snapshot("interval");
    expect(hidden).toBeDefined();

    await writeFile(join(work, "later.txt"), "junk\n");
    await writeFile(join(intent, "deploy.config.ts"), "v2\n");
    const second = await history.snapshot("turn", "  Fix the\n\tgreeting  ");
    expect(second).toBeDefined();

    // Interval captures stay off the timeline and aren't addressable; the turn carries its sanitized label.
    const listed = await history.list();
    expect(listed.map((snapshot) => snapshot.id)).not.toContain(hidden);
    expect(await history.diff(hidden ?? "")).toBeUndefined();
    expect(listed.find((snapshot) => snapshot.id === second)?.label).toBe("Fix the greeting");

    const changes = await history.diff(second ?? "");
    expect(changes).toContainEqual({ scope: "root", path: "hello.txt", status: "modified" });
    expect(changes).toContainEqual({ scope: "root", path: "later.txt", status: "added" });
    expect(changes).toContainEqual({ scope: "intent", path: "deploy.config.ts", status: "modified" });
    expect(changes?.some((change) => change.path.includes(".env"))).toBe(false);

    expect(await history.fileDiff(second ?? "", "root", "hello.txt")).toEqual({ before: "one\n", after: "two\n" });

    expect(await history.restore(first ?? "")).toBe(true);
    expect(await readFile(join(work, "hello.txt"), "utf8")).toBe("one\n");
    expect(existsSync(join(work, "later.txt"))).toBe(false);
    expect(await readFile(join(intent, "deploy.config.ts"), "utf8")).toBe("v1\n");
    // The ignored secret survives the restore's clean, and the nested repo's own git never moved.
    expect(await readFile(join(work, ".env"), "utf8")).toBe("SECRET=x\n");
    expect(await sh(intent, "rev-parse", "HEAD")).toBe(nestedHead);

    const snapshots = await history.list();
    expect(snapshots.map((snapshot) => snapshot.id)).toContain(first);
    expect(snapshots.map((snapshot) => snapshot.trigger)).toContain("restore");
});

// A repo nested below the top level: its id carries a slash, its scope dir the encoded form, and a full
// deletion is recoverable from history.
test("integration: a nested repo scopes under its slash id and restores after deletion", async () => {
    const base = await tempBase();
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const nested = join(work, "clients", "foo");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, "readme.md"), "v1\n");
    const sh = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
    await sh(nested, "init", "-q");
    await sh(nested, "add", "-A");
    await sh(nested, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");

    const history = createWorkspaceHistory({ workspace: workspacePaths(work), historyRoot, logger });
    const first = await history.snapshot("user");
    expect(first).toBeDefined();
    // One filesystem entry per scope: the slash is URI-encoded in the bare dir name.
    expect(existsSync(join(historyRoot, "scopes", "clients%2Ffoo.git"))).toBe(true);

    await writeFile(join(nested, "readme.md"), "v2\n");
    const second = await history.snapshot("turn");
    expect(await history.diff(second ?? "")).toContainEqual({ scope: "clients/foo", path: "readme.md", status: "modified" });

    // rm -rf the whole repo — the deleted scope stays known (bare dir survives) and restore rebuilds the files.
    await rm(nested, { recursive: true, force: true });
    expect(await history.restore(first ?? "")).toBe(true);
    expect(await readFile(join(nested, "readme.md"), "utf8")).toBe("v1\n");
});

// The heal-vs-reap boundary, over REAL git dirs parked the daemon's way (--separate-git-dir, pointer file in
// the worktree). Healing is for accidents; a deletion must reap the parked git dir to /history/trash instead of
// resurrecting the repo as phantom deletions forever.
test("integration: heal rewrites an accidentally deleted pointer; deletions reap the parked git dir", async () => {
    const base = await tempBase();
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const sh = async (cwd: string, ...args: string[]) => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
    await mkdir(join(historyRoot, "gits"), { recursive: true });
    const makeRepo = async (name: string): Promise<string> => {
        const dir = join(work, name);
        await mkdir(dir, { recursive: true });
        await writeFile(join(dir, "readme.md"), "v1\n");
        await sh(dir, "init", "-q", "--separate-git-dir", repoGitDir(historyRoot, name));
        await sh(dir, "add", "-A");
        await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "init");
        return dir;
    };
    const keep = await makeRepo("keep");
    const gone = await makeRepo("gone");
    const emptied = await makeRepo("emptied");
    const lingering = await makeRepo("lingering");
    // Ordinary hidden tool state beside the git dirs is not a repo and must not enter the reap loop.
    await mkdir(join(historyRoot, "gits", ".turbo", "cache"), { recursive: true });
    const history = createWorkspaceHistory({ workspace: workspacePaths(work), historyRoot, logger });

    // keep: only the pointer went missing, the tracked file is still on disk — an accident, healed.
    await rm(join(keep, ".git"));
    // gone: the whole worktree went — reaped outright.
    await rm(gone, { recursive: true, force: true });
    // emptied: tracked files AND pointer deleted; only a sync-ignored remnant keeps the dir alive — reaped.
    await rm(join(emptied, "readme.md"));
    await rm(join(emptied, ".git"));
    await mkdir(join(emptied, "node_modules"), { recursive: true });
    // lingering: tracked files deleted but the pointer survived (sync can't remove ignored paths) — held for a
    // grace cycle first, then reaped with the pointer.
    await rm(join(lingering, "readme.md"));
    await mkdir(join(lingering, "node_modules"), { recursive: true });

    await history.snapshot("interval");
    expect(await readFile(join(keep, ".git"), "utf8")).toContain(repoGitDir(historyRoot, "keep"));
    expect(existsSync(repoGitDir(historyRoot, "keep"))).toBe(true);
    expect(existsSync(repoGitDir(historyRoot, "gone"))).toBe(false);
    expect(existsSync(repoGitDir(historyRoot, "emptied"))).toBe(false);
    // Still within the grace window: nothing reaped yet, and crucially the pointer was NOT healed away.
    expect(existsSync(repoGitDir(historyRoot, "lingering"))).toBe(true);

    // The grace window elapses (Date only — git still runs for real) and the next cycle reaps.
    const realNow = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(realNow + 120_000);
    try {
        await history.snapshot("interval");
    } finally {
        vi.restoreAllMocks();
    }
    expect(existsSync(repoGitDir(historyRoot, "lingering"))).toBe(false);
    expect(existsSync(join(lingering, ".git"))).toBe(false);
    expect(existsSync(join(historyRoot, "gits", ".turbo", "cache"))).toBe(true);

    // Every reaped git dir is parked under trash, recoverable — never erased.
    const trash = await readdir(join(historyRoot, "trash"));
    expect(trash.some((entry) => entry.startsWith("gone-"))).toBe(true);
    expect(trash.some((entry) => entry.startsWith("emptied-"))).toBe(true);
    expect(trash.some((entry) => entry.startsWith("lingering-"))).toBe(true);
    expect(trash.some((entry) => entry.startsWith(".turbo-"))).toBe(false);
});
