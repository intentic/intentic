import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { createRefWatch } from "./ref-watch.js";

// Against real git: cases depend on git's own on-disk layout (linked-worktree HEAD placement, which files a commit
// touches), which a mocked filesystem can't prove.

const run = promisify(execFile);
const roots: string[] = [];
const closers: (() => void)[] = [];

afterEach(async () => {
    for (const close of closers.splice(0)) {
        close();
    }
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const git = async (dir: string, args: string[]): Promise<void> => {
    await run("git", args, { cwd: dir });
};

// A workspace root holding one repo at `root` itself, committed once so HEAD exists.
const workspace = async (): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "refwatch-"));
    roots.push(root);
    await git(root, ["init", "-b", "main"]);
    await git(root, ["config", "user.email", "t@example.com"]);
    await git(root, ["config", "user.name", "T"]);
    await writeFile(join(root, "a.txt"), "one\n");
    await git(root, ["add", "."]);
    await git(root, ["commit", "-m", "first"]);
    return root;
};

// The watcher debounces, so every expectation here is eventual; poll rather than sleep a fixed time.
const waitFor = async (predicate: () => boolean, timeoutMs = 5000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (predicate()) {
            return;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("timed out waiting for a ref batch");
};

const watchRoot = (root: string): string[][] => {
    const batches: string[][] = [];
    const watch = createRefWatch(root, () => () => undefined);
    closers.push(watch.close);
    watch.subscribe((repos) => batches.push(repos));
    return batches;
};

// Long enough to outlast the 250ms debounce, so a straggler batch lands before the next assertion clears it.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

// Attaching is async (rev-parse + chokidar's scan), so this can't wait a fixed time: it repeats a ref move until a
// batch comes back, restoring state each time, rather than betting on one try.
const attached = async (batches: string[][], move: () => Promise<void>): Promise<void> => {
    // A hang detector, not a latency budget: generous enough that suite-wide contention alone won't trip it.
    const deadline = Date.now() + 30_000;
    while (batches.length === 0) {
        if (Date.now() >= deadline) {
            throw new Error("the ref watch never reported a probe move");
        }
        await move();
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await settle();
    batches.length = 0;
};

// A ref move that leaves nothing behind: create and delete are both real writes under `refs/`, what the watch is on.
const probeBranch = (dir: string) => async (): Promise<void> => {
    await git(dir, ["branch", "refwatch-probe"]);
    await git(dir, ["branch", "-D", "refwatch-probe"]);
};

test("a commit in the root repo is reported", async () => {
    const root = await workspace();
    const batches = watchRoot(root);
    await attached(batches, probeBranch(root));

    await writeFile(join(root, "a.txt"), "two\n");
    await git(root, ["commit", "-am", "second"]);

    await waitFor(() => batches.length > 0);
    expect(batches[0]).toEqual(["root"]);
});

test("a branch created and then deleted is reported", async () => {
    const root = await workspace();
    const batches = watchRoot(root);
    await attached(batches, probeBranch(root));

    await git(root, ["branch", "feature"]);
    await waitFor(() => batches.length > 0);

    batches.length = 0;
    await git(root, ["branch", "-D", "feature"]);
    await waitFor(() => batches.length > 0);
    expect(batches[0]).toEqual(["root"]);
});

// Linked worktrees split state across two dirs: refs/packed-refs stay in the common dir, HEAD and in-progress markers
// are per-worktree; missing either half misses it silently.
test("a checkout inside a linked worktree is reported, HEAD being per-worktree", async () => {
    const root = await mkdtemp(join(tmpdir(), "refwatch-wt-"));
    roots.push(root);
    const main = join(root, "main");
    await run("git", ["init", "-b", "main", main]);
    await git(main, ["config", "user.email", "t@example.com"]);
    await git(main, ["config", "user.name", "T"]);
    await writeFile(join(main, "a.txt"), "one\n");
    await git(main, ["add", "."]);
    await git(main, ["commit", "-m", "first"]);
    await git(main, ["branch", "other"]);
    // The linked worktree at <root>/linked is discovered as repo id "linked".
    await git(main, ["worktree", "add", join(root, "linked"), "other"]);

    const batches: string[][] = [];
    const watch = createRefWatch(root, (listener) => {
        listener(["linked"]);
        return () => undefined;
    });
    closers.push(watch.close);
    watch.subscribe((repos) => batches.push(repos));

    // Attachment is proven on this case's own per-worktree HEAD; the branch probe other cases use would only prove the
    // common dir's watch.
    const linked = join(root, "linked");
    await attached(batches, async () => {
        await git(linked, ["checkout", "--detach"]);
        await git(linked, ["checkout", "other"]);
    });

    // Detaching touches only the per-worktree HEAD, no common-dir ref; a branch checkout would write a common-dir ref
    // too and mask a half-broken watch.
    await git(linked, ["checkout", "--detach"]);

    await waitFor(() => batches.some((batch) => batch.includes("linked")));
    expect(batches.flat()).toContain("linked");
});

// Batch count is not asserted (real git+inotify timing is flaky under load); that's covered by ref-watch.test.ts's own
// timers. This proves only what a burst of real commits is reported as.
test("every batch from a burst of commits names the repo that moved, and nothing else", async () => {
    const root = await workspace();
    const batches = watchRoot(root);
    await attached(batches, probeBranch(root));

    for (const text of ["two", "three", "four"]) {
        await writeFile(join(root, "a.txt"), `${text}\n`);
        await git(root, ["commit", "-am", text]);
    }

    await waitFor(() => batches.length > 0);
    // Past the debounce window, so a straggler batch would have landed by the assertion.
    await settle();
    expect(batches.every((batch) => batch.length === 1 && batch[0] === "root")).toBe(true);
});
