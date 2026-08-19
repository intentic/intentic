import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, test } from "vitest";
import { resolvedBranches } from "./handover-branches.js";

/* THE SAME THREE DECISIONS, AGAINST REAL GIT.
 *
 * The unit tests beside this one assert what the module does with a given answer; this one asserts that the
 * answers are what it thinks they are. That is not a formality here — the whole check rests on two exact
 * behaviours of the porcelain: `for-each-ref` prints NOTHING (not an error) for a pattern that matches no ref,
 * and `rev-list --count base..tip` prints `0` for a branch that has not moved. A stub can only ever agree with
 * whoever wrote it, and both of those are the kind of thing that reads as obvious and is worth one temp repo.
 */

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

// One repo at the workspace root with a single commit — the run's pinned base — and whatever branch the test
// wants off it.
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

// The turn ran, the branch was cut, and nothing was committed onto it. `git diff base...agent/abc` succeeds
// here and prints nothing — the quietest way to get a review of no work.
test("a branch that never moved off the base is dropped", async () => {
    const { root, base } = await repoWithBase();
    await sh(root, "branch", "agent/abc");

    expect(await resolvedBranches(root, [{ repo: "root", base }], "agent/abc")).toEqual([]);
});

// The composition names a repo this step never touched, so its branch was never created at all.
test("a branch that does not exist is dropped rather than named", async () => {
    const { root, base } = await repoWithBase();

    expect(await resolvedBranches(root, [{ repo: "root", base }], "agent/never")).toEqual([]);
});

/* The parked spelling counts as much as the live one. Archiving a conversation moves its branch from
 * `refs/heads/agent/<id>` to `refs/agent/<id>` (agents/agent-refs.ts) without moving a commit — a handover
 * that stopped resolving because of that would call an archived predecessor's real work missing. */
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
