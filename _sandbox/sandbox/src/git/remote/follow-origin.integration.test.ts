import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import { createOriginFollow, type OriginFollowDeps } from "./follow-origin.js";
import { fetchTracked, followTracked } from "./follow-upstream.js";
import { trackedBranch } from "./remote.js";

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const AUTHOR = { name: "intentic", email: "agent@intentic.dev" };

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const temp = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-follow-"));
    tempDirs.push(dir);
    return dir;
};

const commit = async (dir: string, name: string, body: string, message = body): Promise<string> => {
    await writeFile(join(dir, name), `${body}\n`);
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
    return sh(dir, "rev-parse", "HEAD");
};

// A workspace holding one repo cloned from a real (local, bare) origin, plus a second clone standing for the other
// writer: another sandbox, CI's fix agent, a colleague.
const workspace = async (): Promise<{ root: string; main: string; other: string }> => {
    const source = await temp();
    await sh(source, "init", "-q", "-b", "main");
    await commit(source, "a.txt", "one");
    await commit(source, "b.txt", "one");
    const origin = await temp();
    await exec("git", ["clone", "-q", "--bare", source, origin]);
    const root = await temp();
    const main = join(root, "app");
    await exec("git", ["clone", "-q", origin, main]);
    const other = await temp();
    await exec("git", ["clone", "-q", origin, other]);
    return { root, main, other };
};

const pushFrom = async (other: string, name: string, body: string): Promise<void> => {
    await commit(other, name, body);
    await sh(other, "push", "-q", "origin", "main");
};

// Fetch and integrate, as one round does for one repo, with nothing guarding it.
const follow = async (dir: string, beforeMove: () => Promise<void> = async () => {}) => {
    const tracked = await trackedBranch(dir);
    if (tracked === undefined) {
        throw new Error("not tracking");
    }
    expect(await fetchTracked(dir, tracked.remote)).toEqual({ ok: true });
    return followTracked(dir, tracked, { author: AUTHOR, beforeMove });
};

const noMergeInProgress = (dir: string): void => {
    expect(existsSync(join(dir, ".git", "MERGE_HEAD"))).toBe(false);
};

test("a branch with nothing of its own fast-forwards onto what the other writer pushed", async () => {
    const { main, other } = await workspace();
    await pushFrom(other, "a.txt", "theirs");

    const outcome = await follow(main);

    expect(outcome).toMatchObject({ status: "fast-forwarded", commits: 1 });
    expect(await readFile(join(main, "a.txt"), "utf8")).toBe("theirs\n");
    expect(await sh(main, "rev-parse", "HEAD")).toBe(await sh(other, "rev-parse", "HEAD"));
});

test("a branch with unpushed commits merges, keeping every local commit's sha so worktrees cut from them stay valid", async () => {
    const { main, other } = await workspace();
    const local = await commit(main, "a.txt", "mine");
    await pushFrom(other, "b.txt", "theirs");

    const outcome = await follow(main);

    expect(outcome).toMatchObject({ status: "merged", commits: 1, ahead: 1 });
    const parents = (await sh(main, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ").slice(1);
    expect(parents).toEqual([local, await sh(other, "rev-parse", "HEAD")]);
    expect(await sh(main, "log", "-1", "--format=%s|%an <%ae>")).toBe("Merge remote-tracking branch 'origin/main'|intentic <agent@intentic.dev>");
    expect(await readFile(join(main, "a.txt"), "utf8")).toBe("mine\n");
    expect(await readFile(join(main, "b.txt"), "utf8")).toBe("theirs\n");
    expect(await sh(main, "status", "--porcelain")).toBe("");
});

test("both sides changing the same lines is reported by path and leaves the checkout exactly as it was", async () => {
    const { main, other } = await workspace();
    const local = await commit(main, "a.txt", "mine");
    await pushFrom(other, "a.txt", "theirs");
    let checkpoints = 0;

    const outcome = await follow(main, async () => {
        checkpoints += 1;
    });

    expect(outcome).toEqual({ status: "conflicted", commits: 1, ahead: 1, paths: ["a.txt"] });
    expect(await sh(main, "rev-parse", "HEAD")).toBe(local);
    expect(await readFile(join(main, "a.txt"), "utf8")).toBe("mine\n");
    expect(await sh(main, "status", "--porcelain")).toBe("");
    noMergeInProgress(main);
    // Nothing moved, so nothing was checkpointed for it.
    expect(checkpoints).toBe(0);
});

test("an uncommitted edit the move would overwrite refuses the move and survives untouched", async () => {
    const { main, other } = await workspace();
    await pushFrom(other, "a.txt", "theirs");
    const head = await sh(main, "rev-parse", "HEAD");
    await writeFile(join(main, "a.txt"), "half-written\n");

    const outcome = await follow(main);

    expect(outcome).toMatchObject({ status: "refused", commits: 1 });
    expect(outcome.status === "refused" ? outcome.reason : "").toContain("a.txt");
    expect(await sh(main, "rev-parse", "HEAD")).toBe(head);
    expect(await readFile(join(main, "a.txt"), "utf8")).toBe("half-written\n");
    noMergeInProgress(main);
});

test("an uncommitted edit elsewhere rides along: the merge lands and the edit is still there", async () => {
    const { main, other } = await workspace();
    await commit(main, "c.txt", "mine");
    await pushFrom(other, "a.txt", "theirs");
    await writeFile(join(main, "b.txt"), "still editing\n");

    const outcome = await follow(main);

    expect(outcome).toMatchObject({ status: "merged" });
    expect(await readFile(join(main, "a.txt"), "utf8")).toBe("theirs\n");
    expect(await readFile(join(main, "b.txt"), "utf8")).toBe("still editing\n");
});

test("an untracked file where the other writer added one refuses rather than overwrite it", async () => {
    const { main, other } = await workspace();
    await pushFrom(other, "new.txt", "theirs");
    await writeFile(join(main, "new.txt"), "mine, never added\n");

    const outcome = await follow(main);

    expect(outcome).toMatchObject({ status: "refused" });
    expect(await readFile(join(main, "new.txt"), "utf8")).toBe("mine, never added\n");
});

test("a HEAD that moved on between building the merge and moving onto it refuses, dropping nobody's commit", async () => {
    const { main, other } = await workspace();
    await commit(main, "c.txt", "mine");
    await pushFrom(other, "a.txt", "theirs");
    let late = "";

    // An agent's land committing while the merge was being built.
    const outcome = await follow(main, async () => {
        late = await commit(main, "d.txt", "landed meanwhile");
    });

    expect(outcome).toMatchObject({ status: "refused" });
    expect(await sh(main, "rev-parse", "HEAD")).toBe(late);
});

type Spy = ReturnType<typeof jest.fn>;
// SAFETY: the rounds call only info and warn on the logger, and debug and error are stood up beside them.
const silent = (): Logger & { readonly warn: Spy; readonly info: Spy } => ({ info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() }) as never;

const depsFor = (root: string, overrides: Partial<OriginFollowDeps> = {}) => {
    const snapshot = jest.fn(async (_trigger: string, _label?: string) => "snap");
    const notifyUserWrite = jest.fn();
    const logger = silent();
    const deps: OriginFollowDeps = {
        workspace: { root },
        enabled: async () => true,
        mainTreeBusy: () => false,
        agentWorktrees: { withRepoLock: (_repo, task) => task(), repoBusy: () => false },
        history: { snapshot, notifyUserWrite },
        logger,
        ...overrides,
    };
    return { deps, snapshot, notifyUserWrite, logger };
};

test("a round catches every tracking repo up, checkpoints before moving, and records the move as the owner's", async () => {
    const { root, main, other } = await workspace();
    await mkdir(join(root, "scratch"));
    await sh(join(root, "scratch"), "init", "-q", "-b", "main");
    await pushFrom(other, "a.txt", "theirs");
    const { deps, snapshot, notifyUserWrite } = depsFor(root);

    const results = await createOriginFollow(deps).round();

    expect(results).toEqual([
        { repo: "app", outcome: expect.objectContaining({ status: "fast-forwarded", commits: 1 }) },
        { repo: "scratch", outcome: { status: "untracked" } },
    ]);
    expect(await readFile(join(main, "a.txt"), "utf8")).toBe("theirs\n");
    expect(snapshot).toHaveBeenCalledWith("user", "before following origin/main in app");
    expect(notifyUserWrite).toHaveBeenCalledTimes(1);
});

test("switched off, a round fetches nothing and moves nothing", async () => {
    const { root, main, other } = await workspace();
    await pushFrom(other, "a.txt", "theirs");
    const fetch = jest.fn(async () => ({ ok: true }) as const);
    const { deps } = depsFor(root, { enabled: async () => false, fetch });

    expect(await createOriginFollow(deps).round()).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
    expect(await readFile(join(main, "a.txt"), "utf8")).toBe("one\n");
});

test("a turn working in the main tree defers the move to a later round", async () => {
    const { root, main, other } = await workspace();
    await pushFrom(other, "a.txt", "theirs");
    const { deps, snapshot } = depsFor(root, { mainTreeBusy: () => true });

    const results = await createOriginFollow(deps).round();

    expect(results).toEqual([{ repo: "app", outcome: { status: "deferred", why: "main-tree-turn" } }]);
    expect(await readFile(join(main, "a.txt"), "utf8")).toBe("one\n");
    expect(snapshot).not.toHaveBeenCalled();
});

test("a merge the owner has open is left alone", async () => {
    const { root, main, other } = await workspace();
    await commit(main, "a.txt", "mine");
    await pushFrom(other, "a.txt", "theirs");
    await sh(main, "fetch", "-q");
    await exec("git", ["-C", main, "-c", "user.name=t", "-c", "user.email=t@t", "merge", "-q", "origin/main"]).catch(() => undefined);
    expect(existsSync(join(main, ".git", "MERGE_HEAD"))).toBe(true);
    const { deps } = depsFor(root);

    const results = await createOriginFollow(deps).round();

    expect(results).toEqual([{ repo: "app", outcome: { status: "deferred", why: "operation" } }]);
});

test("the same conflict is said once, not every round", async () => {
    const { root, main, other } = await workspace();
    await commit(main, "a.txt", "mine");
    await pushFrom(other, "a.txt", "theirs");
    const { deps, logger } = depsFor(root);
    const follower = createOriginFollow(deps);

    await follower.round();
    await follower.round();

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]?.[0]).toMatchObject({ repo: "app", outcome: { status: "conflicted", paths: ["a.txt"] } });
});
