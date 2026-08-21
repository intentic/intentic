import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { afterEach, expect, test } from "vitest";
import { createBranch, deleteBranch, listBranches } from "./branches.js";
import { fetchRemote, pullRemote, pushBranch, remoteState } from "./remote.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const temp = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-remote-"));
    tempDirs.push(dir);
    return dir;
};

const commit = async (dir: string, name: string, body: string): Promise<void> => {
    await writeFile(join(dir, name), `${body}\n`);
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", body);
};

// A clone with a real (local, bare) origin: enough for fetch/pull/push to exercise the actual git paths
// without a network. Returns the clone; the bare repo is its origin.
const cloned = async (): Promise<{ clone: string; origin: string }> => {
    const source = await temp();
    await sh(source, "init", "-q", "-b", "main");
    await commit(source, "a.txt", "one");

    const origin = await temp();
    await exec("git", ["clone", "-q", "--bare", source, origin]);

    const clone = await temp();
    await exec("git", ["clone", "-q", origin, clone]);
    await sh(clone, "config", "user.name", "t");
    await sh(clone, "config", "user.email", "t@t");
    return { clone, origin };
};

test("remoteState reports the remote, branch and upstream of a fresh clone as in sync", async () => {
    const { clone } = await cloned();
    const state = await remoteState(clone);
    expect(state.remote).toBe("origin");
    expect(state.branch).toBe("main");
    expect(state.upstream).toBe("origin/main");
    expect(state).toMatchObject({ ahead: 0, behind: 0 });
});

test("remoteState counts local commits as ahead", async () => {
    const { clone } = await cloned();
    await commit(clone, "b.txt", "two");
    expect(await remoteState(clone)).toMatchObject({ ahead: 1, behind: 0 });
});

test("remoteState counts upstream commits as behind, but only after a fetch", async () => {
    const { clone, origin } = await cloned();
    // Push a commit to origin from a SECOND clone, so our clone's tracking ref is stale.
    const other = await temp();
    await exec("git", ["clone", "-q", origin, other]);
    await sh(other, "config", "user.name", "t");
    await sh(other, "config", "user.email", "t@t");
    await commit(other, "c.txt", "three");
    await sh(other, "push", "-q", "origin", "main");

    // Nothing fetched yet: the tracking ref still points where it did, so we read as in sync. This is git's
    // real semantics and the reason the panel has a Fetch button at all.
    expect(await remoteState(clone)).toMatchObject({ ahead: 0, behind: 0 });

    expect(await fetchRemote(clone)).toEqual({ ok: true });
    expect(await remoteState(clone)).toMatchObject({ ahead: 0, behind: 1 });
});

test("remoteState is total on a repo with no remote and no commits", async () => {
    const dir = await temp();
    await sh(dir, "init", "-q");
    // No remote and no upstream, counts zero, no throw. The branch name IS reported: git names the unborn
    // branch from init.defaultBranch, because pushBranch reads its refspec from here.
    const state = await remoteState(dir);
    expect(state.remote).toBeUndefined();
    expect(state.upstream).toBeUndefined();
    expect(state).toMatchObject({ ahead: 0, behind: 0 });
});

test("remoteState reports a remote but no upstream for a branch never pushed", async () => {
    const { clone } = await cloned();
    await createBranch(clone, "feature", undefined, true);
    const state = await remoteState(clone);
    expect(state.remote).toBe("origin");
    expect(state.branch).toBe("feature");
    expect(state.upstream).toBeUndefined();
});

// `git remote` sorts ALPHABETICALLY, so a repo that moved hosts and kept its old remote lists that one first.
// Falling back to the first line would publish new branches to the host the repo moved off.
test("remoteState falls back to origin, not to whichever remote name sorts first", async () => {
    const { clone } = await cloned();
    await sh(clone, "remote", "add", "abandoned", "git@gitlab.com:acme/web.git");
    await createBranch(clone, "feature", undefined, true);
    expect(await sh(clone, "remote")).toBe("abandoned\norigin");

    const state = await remoteState(clone);
    expect(state.remote).toBe("origin");
    expect(state.upstream).toBeUndefined();
});

test("remoteState still falls back to the only remote there is when it isn't named origin", async () => {
    const { clone } = await cloned();
    await sh(clone, "remote", "rename", "origin", "upstream");
    await createBranch(clone, "feature", undefined, true);

    expect((await remoteState(clone)).remote).toBe("upstream");
});

/* WHAT THIS COSTS, not just what it answers. remoteState runs for every repo on every Changes scan, so a
 * spawn here is a scan-wide multiplier: these pin the read order that makes the steady state one spawn, and
 * would fail the moment a config read crept back in front of it. */
const counted =
    (calls: string[][]): GitRunner =>
    (dir, args, env) => {
        calls.push([...args]);
        return defaultGit(dir, args, env);
    };

test("a tracking branch costs ONE spawn: no branch read, no remote listing", async () => {
    const { clone } = await cloned();
    const calls: string[][] = [];
    // The Changes scan holds the branch already: it comes off the same status pass that produced the rows.
    const state = await remoteState(clone, { branch: "main" }, counted(calls));

    expect(state).toMatchObject({ remote: "origin", branch: "main", upstream: "origin/main", ahead: 0, behind: 0 });
    // for-each-ref alone: it carries the tracking ref, its remote AND the ahead/behind counts.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("for-each-ref");
});

test("only a branch with no upstream pays for the remote listing, which is where a publish has to go", async () => {
    const { clone } = await cloned();
    await sh(clone, "checkout", "-q", "-b", "unpushed");
    const calls: string[][] = [];
    const state = await remoteState(clone, { branch: "unpushed" }, counted(calls));

    expect(state).toMatchObject({ remote: "origin", branch: "unpushed", ahead: 0, behind: 0 });
    expect(state.upstream).toBeUndefined();
    expect(calls.map((args) => args[0])).toEqual(["for-each-ref", "remote"]);
});

test("a caller that knows no branch still gets a truthful answer, at the cost of the read it skipped", async () => {
    const { clone } = await cloned();
    const calls: string[][] = [];
    const state = await remoteState(clone, {}, counted(calls));

    expect(state).toMatchObject({ remote: "origin", branch: "main", upstream: "origin/main" });
    expect(calls.map((args) => args[0])).toEqual(["branch", "for-each-ref"]);
});

test("pullRemote fast-forwards, and reports a non-fast-forward as a reason rather than throwing", async () => {
    const { clone, origin } = await cloned();
    const other = await temp();
    await exec("git", ["clone", "-q", origin, other]);
    await sh(other, "config", "user.name", "t");
    await sh(other, "config", "user.email", "t@t");
    await commit(other, "c.txt", "three");
    await sh(other, "push", "-q", "origin", "main");

    expect(await pullRemote(clone)).toEqual({ ok: true });
    expect(existsSync(join(clone, "c.txt"))).toBe(true);

    // Now diverge: a local commit plus another upstream commit means the pull cannot fast-forward.
    await commit(clone, "local.txt", "local");
    await commit(other, "d.txt", "four");
    await sh(other, "push", "-q", "origin", "main");

    const result = await pullRemote(clone);
    expect(result.ok).toBe(false);
    // A value with git's own reason: the panel renders it and offers rebase/merge from the graph.
    expect(result.ok === false && result.reason.length > 0).toBe(true);
    // Nothing half-applied: the local commit is still the tip.
    expect(await sh(clone, "log", "-1", "--format=%s")).toBe("local");
});

test("pushBranch sends the current branch and clears ahead", async () => {
    const { clone } = await cloned();
    await commit(clone, "b.txt", "two");
    expect(await remoteState(clone)).toMatchObject({ ahead: 1 });

    expect(await pushBranch(clone, {})).toEqual({ ok: true });
    expect(await remoteState(clone)).toMatchObject({ ahead: 0, behind: 0 });
});

test("pushBranch publishes a never-pushed branch, so it comes back with a readable upstream", async () => {
    const { clone } = await cloned();
    await createBranch(clone, "feature", undefined, true);
    await commit(clone, "f.txt", "feature work");
    expect((await remoteState(clone)).upstream).toBeUndefined();

    // Naming the remote and branch explicitly means git would happily push WITHOUT tracking, leaving
    // ahead/behind permanently unreadable. Publishing on this first push is what avoids that dead end.
    expect(await pushBranch(clone, {})).toEqual({ ok: true });
    expect(await remoteState(clone)).toMatchObject({ upstream: "origin/feature", ahead: 0, behind: 0 });
});

test("pushBranch never repoints an upstream the user already has", async () => {
    const { clone } = await cloned();
    await commit(clone, "b.txt", "two");
    await sh(clone, "branch", "--set-upstream-to=origin/main", "main");

    expect(await pushBranch(clone, {})).toEqual({ ok: true });
    expect(await sh(clone, "config", "--get", "branch.main.merge")).toBe("refs/heads/main");
});

// A fork: `origin` (where you push) plus `upstream` (where you pull from). `git remote` lists them
// alphabetically, so the FIRST remote is not the one `main` tracks, and pushing to it would land the commits
// on the wrong repo while reporting ok and leaving `ahead` stuck at 1 forever.
const forked = async (): Promise<{ clone: string; origin: string; upstream: string }> => {
    const { clone, origin } = await cloned();
    const upstream = await temp();
    await exec("git", ["clone", "-q", "--bare", origin, upstream]);
    await sh(clone, "remote", "add", "upstream", upstream);
    await sh(clone, "fetch", "-q", "upstream");
    await sh(clone, "branch", "--set-upstream-to=upstream/main", "main");
    return { clone, origin, upstream };
};

test("remoteState names the branch's OWN remote, not the first one configured", async () => {
    const { clone } = await forked();
    const state = await remoteState(clone);
    expect(state.remote).toBe("upstream");
    expect(state.upstream).toBe("upstream/main");
});

test("pushBranch pushes to the remote the branch tracks, not the first one git lists", async () => {
    const { clone, origin, upstream } = await forked();
    await commit(clone, "b.txt", "two");
    expect(await remoteState(clone)).toMatchObject({ ahead: 1 });

    expect(await pushBranch(clone, {})).toEqual({ ok: true });
    // The commit landed on the tracked remote…
    expect(await sh(upstream, "log", "-1", "--format=%s", "main")).toBe("two");
    // …and NOT on the alphabetically-first one, which is the failure this guards: a push that reports ok while
    // the ahead count never moves.
    expect(await sh(origin, "log", "-1", "--format=%s", "main")).toBe("one");
    expect(await remoteState(clone)).toMatchObject({ ahead: 0, behind: 0 });
});

test("pushBranch publishes a never-pushed branch to the repo's configured remote", async () => {
    const { clone, origin } = await forked();
    // A brand-new branch tracks nothing, so there is no remote of its own to honour: it publishes to the
    // repo's first configured remote, which is the only defensible default.
    await createBranch(clone, "feature", undefined, true);
    await commit(clone, "f.txt", "work");

    expect(await pushBranch(clone, {})).toEqual({ ok: true });
    expect(await sh(origin, "rev-parse", "--verify", "feature")).not.toBe("");
    expect((await remoteState(clone)).upstream).toBe("origin/feature");
});

test("pushBranch reports a missing remote as a reason, not a throw", async () => {
    const dir = await temp();
    await sh(dir, "init", "-q", "-b", "main");
    await commit(dir, "a.txt", "one");
    expect(await pushBranch(dir, {})).toEqual({ ok: false, reason: "no remote configured" });
});

test("listBranches reports current, upstream and per-branch ahead/behind", async () => {
    const { clone } = await cloned();
    await commit(clone, "b.txt", "two"); // main is now 1 ahead
    await createBranch(clone, "feature", undefined, false); // created at HEAD, not checked out

    const branches = await listBranches(clone);
    const main = branches.find((branch) => branch.name === "main");
    const feature = branches.find((branch) => branch.name === "feature");

    expect(main).toMatchObject({ current: true, upstream: "origin/main", ahead: 1, behind: 0 });
    // A branch with no upstream reads as zeros, not as an error.
    expect(feature).toMatchObject({ current: false, ahead: 0, behind: 0 });
    expect(feature?.upstream).toBeUndefined();
});

test("listBranches is empty on a repo with no commits", async () => {
    const dir = await temp();
    await sh(dir, "init", "-q");
    expect(await listBranches(dir)).toEqual([]);
});

test("createBranch can check out immediately, and deleteBranch refuses unmerged work without force", async () => {
    const { clone } = await cloned();
    await createBranch(clone, "feature", undefined, true);
    expect(await sh(clone, "branch", "--show-current")).toBe("feature");
    await commit(clone, "f.txt", "unmerged work");

    await sh(clone, "checkout", "-q", "main");
    // git refuses to drop a branch whose commits are nowhere else: that refusal propagates so the UI can
    // offer the deliberate force retry rather than the daemon silently discarding commits.
    await expect(deleteBranch(clone, "feature", false)).rejects.toThrow();
    await deleteBranch(clone, "feature", true);
    expect((await listBranches(clone)).some((branch) => branch.name === "feature")).toBe(false);
});

test("listBranches flags a branch whose upstream was deleted on the remote as gone", async () => {
    const { clone, origin } = await cloned();
    await createBranch(clone, "feature", undefined, true);
    await commit(clone, "f.txt", "work");
    // No options: the first push of an untracked branch publishes it, which is what gives it an upstream to
    // lose in the first place.
    await pushBranch(clone, {});

    // Delete it on the "remote", then prune: the tracking ref disappears but the config still names it.
    await sh(origin, "branch", "-D", "feature");
    await fetchRemote(clone);

    const feature = (await listBranches(clone)).find((branch) => branch.name === "feature");
    expect(feature?.gone).toBe(true);
});
