import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, test } from "vitest";
import { createRefWatch } from "./ref-watch.js";

/* Against real git repositories, because every interesting case here is one git's own on-disk layout decides:
 * where a linked worktree keeps HEAD versus where it keeps refs, and which files a commit actually touches. A
 * mocked filesystem would only assert the shape this test was written against. */

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

// The watcher debounces, so every expectation here is "eventually": poll rather than sleep a fixed time, or the
// test is either flaky or slow.
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

// Long enough after a batch that a straggler from the same window has landed too: the watcher debounces at
// 250ms, and everything here that clears `batches` has to outlast that or it clears them into the next
// assertion.
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 600));

/* ATTACHING IS ASYNCHRONOUS, so waiting a constant for it is the one thing this file must not do. Setting a
 * watcher up runs a `git rev-parse` and then chokidar's own initial scan, and on a loaded machine that outruns
 * any number written here. What made it a bad flake rather than a slow test is that a ref moved before the
 * watch exists is reported by NOTHING: the case then waited out its entire budget for a batch that was never
 * coming, and failed as "timed out waiting for a ref batch", which reads as the watcher being broken.
 *
 * Which is why the probe REPEATS. One move and a wait is the same bet in a different place: fire it a moment
 * too early and there is nothing left to report it. So keep moving a ref until a move comes back: the batch
 * is the proof, and it costs exactly what attaching took. Each `move` puts the repo back as it found it, so
 * the case still starts from the state it was written against. */
const attached = async (batches: string[][], move: () => Promise<void>): Promise<void> => {
    // A hang detector, not a latency budget: attaching plus one probe measured ~7s with every package's suite
    // running at once, so a ten-second ceiling was about to fail a watcher that was merely waiting its turn.
    // Well clear of that, still a fraction of the suite's own minute, so a watcher that never attaches says so.
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

// A ref move that leaves nothing behind: the branch is created and deleted, and both halves are a real write
// under `refs/`, which is what the watch is on.
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

/* THE CASE THE WATCHER EXISTS FOR. Every agent session runs in a LINKED WORKTREE, where git splits the state
 * this watcher reads across two directories: refs and packed-refs stay in the common dir, while HEAD and the
 * in-progress markers are per worktree. A watcher that resolved only one of them would miss half of what it is
 * for, and would miss it silently, since the other half keeps arriving. */
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
    // The linked worktree sits at <root>/linked, so the watcher discovers it as the repo id "linked".
    await git(main, ["worktree", "add", join(root, "linked"), "other"]);

    const batches: string[][] = [];
    const watch = createRefWatch(root, (listener) => {
        listener(["linked"]);
        return () => undefined;
    });
    closers.push(watch.close);
    watch.subscribe((repos) => batches.push(repos));

    /* Attachment is proven on the SAME per-worktree HEAD this case is about, then put back: the branch probe
     * the other cases use would only have proved the common dir's watch, which is the half this one exists to
     * distrust. */
    const linked = join(root, "linked");
    await attached(batches, async () => {
        await git(linked, ["checkout", "--detach"]);
        await git(linked, ["checkout", "other"]);
    });

    /* Detaching writes the linked worktree's OWN HEAD in its per-worktree admin dir and touches NO ref in the
     * common dir, so this passes only if the gitdir is resolved and watched separately from the common dir.
     * (Checking out a branch would have written a common-dir ref too and let a half-right watcher through.) */
    await git(linked, ["checkout", "--detach"]);

    await waitFor(() => batches.some((batch) => batch.includes("linked")));
    expect(batches.flat()).toContain("linked");
});

/* HOW MANY BATCHES A BURST BECOMES IS NOT ASKED HERE, and that is the point of the case rather than a gap in
 * it. Counting them behind a real watcher measures whether the runner got three git subprocesses and their
 * inotify events through inside one 250ms window: true on an idle box, false on one running every package's
 * vitest at once, where each commit opened its own window and the case failed as "expected 3 to be less than
 * 3", reading as a broken debounce over a watcher that was working. The coalescing is settled in ref-watch.test
 * .ts against timers the test owns; what only real git can say is what a burst of real commits is reported AS,
 * which is this. */
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
