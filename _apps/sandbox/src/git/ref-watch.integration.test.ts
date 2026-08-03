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

// The watcher debounces, so every expectation here is "eventually" — poll rather than sleep a fixed time, or the
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

test("a commit in the root repo is reported", async () => {
    const root = await workspace();
    const batches = watchRoot(root);
    // Give the watcher time to attach before the write it is meant to see.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await writeFile(join(root, "a.txt"), "two\n");
    await git(root, ["commit", "-am", "second"]);

    await waitFor(() => batches.length > 0);
    expect(batches[0]).toEqual(["root"]);
});

test("a branch created and then deleted is reported", async () => {
    const root = await workspace();
    const batches = watchRoot(root);
    await new Promise((resolve) => setTimeout(resolve, 300));

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
 * for — and would miss it silently, since the other half keeps arriving. */
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
    const watch = createRefWatch(root, (listener) => (listener(["linked"]), () => undefined));
    closers.push(watch.close);
    watch.subscribe((repos) => batches.push(repos));
    await new Promise((resolve) => setTimeout(resolve, 300));

    /* Detaching writes the linked worktree's OWN HEAD in its per-worktree admin dir and touches NO ref in the
     * common dir — so this passes only if the gitdir is resolved and watched separately from the common dir.
     * (Checking out a branch would have written a common-dir ref too and let a half-right watcher through.) */
    await git(join(root, "linked"), ["checkout", "--detach"]);

    await waitFor(() => batches.some((batch) => batch.includes("linked")));
});

test("a burst of commits coalesces into one batch", async () => {
    const root = await workspace();
    const batches = watchRoot(root);
    await new Promise((resolve) => setTimeout(resolve, 300));

    for (const text of ["two", "three", "four"]) {
        await writeFile(join(root, "a.txt"), `${text}\n`);
        await git(root, ["commit", "-am", text]);
    }

    await waitFor(() => batches.length > 0);
    // Settle past the debounce window so a straggler batch would have landed by the assertion.
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(batches.every((batch) => batch.length === 1 && batch[0] === "root")).toBe(true);
    // The point of the debounce: three commits are not three round trips to every connected browser.
    expect(batches.length).toBeLessThan(3);
});
