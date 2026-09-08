import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { resolvedBranches } from "./handover-branches.js";

// Same three decisions against real git, not stubs: `for-each-ref` prints nothing (not an error) for no match, and
// `rev-list --count` prints `0` for a branch that has not moved.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

// One repo at the workspace root with a single commit: the run's pinned base, plus whatever branch a test adds.
const repoWithBase = async (): Promise<{ root: string; base: string }> => {
    const root = await mkdtemp(join(tmpdir(), "handover-"));
    await sh(root, "init", "-q", "--initial-branch=main", ".");
    await sh(root, "config", "user.email", "t@example.com");
    await sh(root, "config", "user.name", "t");
    await writeFile(join(root, "a.txt"), "a\n");
    await sh(root, "add", "-A");
    await sh(root, "commit", "-qm", "base");
    return { root, base: await sh(root, "rev-parse", "HEAD") };
};

test("a branch carrying a commit over the pinned base is handed on", async () => {
    const { root, base } = await repoWithBase();
    await sh(root, "checkout", "-q", "-b", "agent/abc");
    await writeFile(join(root, "b.txt"), "b\n");
    await sh(root, "add", "-A");
    await sh(root, "commit", "-qm", "the work");
    await sh(root, "checkout", "-q", "main");

    expect(await resolvedBranches(root, [{ repo: "root", base }], "agent/abc")).toEqual([{ repo: "root", base, branch: "agent/abc" }]);
});

// `git diff base...agent/abc` succeeds and prints nothing when the branch never moved: the quietest empty review.
test("a branch that never moved off the base is dropped", async () => {
    const { root, base } = await repoWithBase();
    await sh(root, "branch", "agent/abc");

    expect(await resolvedBranches(root, [{ repo: "root", base }], "agent/abc")).toEqual([]);
});

test("a branch that does not exist is dropped rather than named", async () => {
    const { root, base } = await repoWithBase();

    expect(await resolvedBranches(root, [{ repo: "root", base }], "agent/never")).toEqual([]);
});

// Archiving moves a branch from `refs/heads/agent/<id>` to `refs/agent/<id>` without moving a commit; the parked
// spelling must still resolve.
test("a parked branch still resolves, because archiving moves the ref and not the work", async () => {
    const { root, base } = await repoWithBase();
    await sh(root, "checkout", "-q", "-b", "agent/abc");
    await writeFile(join(root, "b.txt"), "b\n");
    await sh(root, "add", "-A");
    await sh(root, "commit", "-qm", "the work");
    await sh(root, "checkout", "-q", "main");
    const tip = await sh(root, "rev-parse", "agent/abc");
    await sh(root, "update-ref", "refs/agent/abc", tip);
    await sh(root, "update-ref", "-d", "refs/heads/agent/abc");

    expect(await resolvedBranches(root, [{ repo: "root", base }], "agent/abc")).toEqual([{ repo: "root", base, branch: "agent/abc" }]);
});
