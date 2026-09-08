import { join } from "node:path";

import { expect, test } from "vitest";

import { createApp } from "../app.js";

import { clientFor, errorCode } from "../harness/route-client.testing.js";
import { fakeFiles, fakeHistory, tempWorkspace } from "../harness/route-fakes.testing.js";
import { services } from "../harness/route-services.testing.js";

// The git routes, driven over the daemon's HTTP surface exactly as the browser drives them; fakes and client are shared
// via route-services.testing.ts and its siblings.

test("git.status resolves the repo dir, and rejects an unknown repo", async () => {
    const workspace = tempWorkspace([{ name: "app" }]);
    const seen: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    init: async () => {},
                    status: async (dir) => {
                        seen.push(dir);
                        return { branch: "main", dirty: false, files: [] };
                    },
                    listFiles: async () => [],
                    commitAll: async () => false,
                    clone: async () => {},
                },
            }),
        ),
    );
    expect(await client.git.status({ repo: "app" })).toEqual({ branch: "main", dirty: false, files: [] });
    expect(seen).toEqual([join(workspace.root, "app")]);
    expect(await errorCode(client.git.status({ repo: "nope" }))).toBe("NOT_FOUND");
});

test("git.files lists the repo's tracked files", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    init: async () => {},
                    status: async () => ({ branch: "main", dirty: false, files: [] }),
                    listFiles: async (dir) => (dir === join(workspace.root, "intent") ? ["deploy.config.ts", "package.json"] : []),
                    commitAll: async () => false,
                    clone: async () => {},
                },
            }),
        ),
    );
    expect(await client.git.files({ repo: "intent" })).toEqual({ files: ["deploy.config.ts", "package.json"] });
});

test("git.readFile reads a contained file, NOT_FOUNDs a missing one, and BAD_REQUESTs a path escape", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const client = clientFor(
        createApp(
            services({
                workspace,
                files: fakeFiles({
                    read: async (absPath) =>
                        absPath === join(workspace.root, "intent", "deploy.config.ts") ? "export const intent = 1;" : undefined,
                }),
            }),
        ),
    );
    expect(await client.git.readFile({ repo: "intent", path: "deploy.config.ts" })).toEqual({
        path: "deploy.config.ts",
        content: "export const intent = 1;",
    });
    expect(await errorCode(client.git.readFile({ repo: "intent", path: "nope.ts" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.git.readFile({ repo: "intent", path: "../../etc/passwd" }))).toBe("BAD_REQUEST");
});

test("git.writeFile writes a contained file and rejects a path escape", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const writes: { path: string; content: string | Uint8Array }[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                files: fakeFiles({
                    write: async (absPath, content) => {
                        writes.push({ path: absPath, content });
                    },
                }),
            }),
        ),
    );
    expect(await client.git.writeFile({ repo: "intent", path: "deploy.config.ts", content: "next" })).toEqual({ ok: true });
    expect(writes).toEqual([{ path: join(workspace.root, "intent", "deploy.config.ts"), content: "next" }]);
    expect(await errorCode(client.git.writeFile({ repo: "intent", path: "../escape", content: "x" }))).toBe("BAD_REQUEST");
    expect(writes).toHaveLength(1);
});

test("git.changes aggregates dirty repos across root + roles + clones, skipping clean ones and reporting broken ones", async () => {
    const workspace = tempWorkspace([{ name: "intent" }, { name: "shop" }]);
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    ...services().git,
                    changedFiles: async (dir) => {
                        if (dir === workspace.root) {
                            return { branch: "main", conflicted: [], staged: [], unstaged: [{ path: "notes.md", status: "added" as const }], blobs: new Map() };
                        }
                        if (dir === join(workspace.root, "shop")) {
                            throw new Error("broken repo");
                        }
                        return { conflicted: [], staged: [], unstaged: [], blobs: new Map() };
                    },
                },
            }),
        ),
    );
    expect(await client.git.changes()).toEqual({
        repos: [
            {
                repo: "root",
                branch: "main",
                conflicted: [],
                staged: [],
                unstaged: [{ path: "notes.md", status: "added" }],
                remote: { ahead: 0, behind: 0 },
            },
            { repo: "shop", conflicted: [], staged: [], unstaged: [], error: "broken repo" },
        ],
    });
});

test("the git-history graph resolves the 'root' scope to /work: reads, and a HEAD-mover that checkpoints first", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const calls: string[] = [];
    const snapshots: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                history: fakeHistory({
                    snapshot: async (trigger, label) => {
                        snapshots.push(`${trigger} ${label}`);
                        return undefined;
                    },
                }),
                git: {
                    ...services().git,
                    commitLog: async (dir, limit, skip) => {
                        calls.push(`log ${dir} ${limit} ${skip}`);
                        return { branch: "main", commits: [], hasMore: false };
                    },
                    commitChanges: async (dir, sha) => {
                        calls.push(`commit-diff ${dir} ${sha}`);
                        return [];
                    },
                    checkoutRef: async (dir, ref) => {
                        calls.push(`checkout ${dir} ${ref}`);
                    },
                },
            }),
        ),
    );
    expect(await client.git.log({ repo: "root" })).toEqual({ repo: "root", branch: "main", commits: [], hasMore: false });
    expect(await client.git.commitDiff({ repo: "root", sha: "abcdef1" })).toEqual({ files: [] });
    expect(await client.git.checkout({ repo: "root", ref: "abcdef1" })).toEqual({ ok: true });
    expect(await client.git.log({ repo: "intent" })).toEqual({ repo: "intent", branch: "main", commits: [], hasMore: false });
    expect(calls).toEqual([
        `log ${workspace.root} 300 0`,
        `commit-diff ${workspace.root} abcdef1`,
        `checkout ${workspace.root} abcdef1`,
        `log ${join(workspace.root, "intent")} 300 0`,
    ]);
    expect(snapshots).toEqual(["user before checkout abcdef1"]);
    expect(await errorCode(client.git.log({ repo: "nope" }))).toBe("NOT_FOUND");
});

test("git.commit records the index, staging the whole repo first when the target says so", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const calls: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    ...services().git,
                    stageAll: async (dir) => {
                        calls.push(`stage-all ${dir}`);
                    },
                    stagePaths: async (dir, paths) => {
                        calls.push(`stage ${dir} ${paths.join(",")}`);
                    },
                    commitIndex: async (dir, message) => {
                        calls.push(`index ${dir} ${message}`);
                        return true;
                    },
                },
            }),
        ),
    );
    expect(await client.git.commit({ repo: "root", message: "m1" })).toEqual({ committed: true });
    expect(await client.git.commit({ repo: "intent", message: "m2", stage: {} })).toEqual({ committed: true });
    expect(await client.git.commit({ repo: "intent", message: "m3", stage: { paths: ["a.ts", "b.ts"] } })).toEqual({ committed: true });
    const intent = join(workspace.root, "intent");
    expect(calls).toEqual([
        `index ${workspace.root} m1`,
        `stage-all ${intent}`,
        `index ${intent} m2`,
        `stage ${intent} a.ts,b.ts`,
        `index ${intent} m3`,
    ]);
});

// `feat!(git): …` misplaces `!` after the type, not the scope, so a hook reads subject/type as empty; only unparsable
// messages get repaired, not disagreements.
test("git.commit files a message a conventional parser can read, and leaves the rest of it alone", async () => {
    const workspace = tempWorkspace([]);
    const filed: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    ...services().git,
                    commitIndex: async (_dir, message) => {
                        filed.push(message);
                        return true;
                    },
                },
            }),
        ),
    );
    await client.git.commit({ repo: "root", message: "feat!(git): bulk verbs take a scope\n\nRelease-Note: Commit everything in one step." });
    await client.git.commit({ repo: "root", message: "Feat(git): Bulk verbs take a scope." });
    expect(filed).toEqual([
        "feat(git)!: bulk verbs take a scope\n\nRelease-Note: Commit everything in one step.",
        "Feat(git): Bulk verbs take a scope.",
    ]);
});

test("git actions refuse a target that names both paths and a scope", async () => {
    const client = clientFor(createApp(services({ workspace: tempWorkspace([]) })));
    expect(await errorCode(client.git.stage({ repo: "root", paths: ["a.ts"], scope: { side: "unstaged" } }))).toBe("BAD_REQUEST");
    expect(await errorCode(client.git.discard({ repo: "root", paths: ["a.ts"], scope: {} }))).toBe("BAD_REQUEST");
});

// 1500 unstaged files exceeds both MAX_REPO_CHANGES and MAX_ACTION_PATHS, the ceilings a side scope must get past.
test("a side scope stages every matching file, past anything a request could enumerate", async () => {
    const unstaged = Array.from({ length: 1500 }, (_, index) => ({ path: `src/f${index}.ts`, status: "modified" as const }));
    const staged: string[][] = [];
    const client = clientFor(
        createApp(
            services({
                workspace: tempWorkspace([]),
                git: {
                    ...services().git,
                    changedFiles: async () => ({ conflicted: [], staged: [], unstaged, blobs: new Map() }),
                    stagePaths: async (_dir, paths) => {
                        staged.push([...paths]);
                    },
                },
            }),
        ),
    );
    expect(await client.git.stage({ repo: "root", scope: { side: "unstaged" } })).toEqual({ ok: true });
    expect(staged).toEqual([unstaged.map((change) => change.path)]);
    expect(await errorCode(client.git.stage({ repo: "root", paths: unstaged.map((change) => change.path) }))).toBe("BAD_REQUEST");
});

test("stage and unstage record no checkpoint and no user write; discard does both", async () => {
    const workspace = tempWorkspace([]);
    const snapshots: string[] = [];
    let writes = 0;
    const client = clientFor(
        createApp(
            services({
                workspace,
                history: fakeHistory({
                    snapshot: async (trigger, label) => {
                        snapshots.push(`${trigger} ${label}`);
                        return undefined;
                    },
                    notifyUserWrite: () => {
                        writes += 1;
                    },
                }),
            }),
        ),
    );
    expect(await client.git.stage({ repo: "root", paths: ["a.ts"] })).toEqual({ ok: true });
    expect(await client.git.unstage({ repo: "root", paths: ["a.ts"] })).toEqual({ ok: true });
    expect(snapshots).toEqual([]);
    expect(writes).toBe(0);

    expect(await client.git.discard({ repo: "root", paths: ["a.ts"] })).toEqual({ ok: true });
    expect(snapshots).toEqual(["user before discard in root"]);
    expect(writes).toBe(1);
});

test("an empty target stages the whole repo in one command, naming nothing", async () => {
    const calls: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace: tempWorkspace([]),
                git: {
                    ...services().git,
                    changedFiles: async () => {
                        calls.push("status");
                        return { conflicted: [], staged: [], unstaged: [], blobs: new Map() };
                    },
                    stageAll: async () => {
                        calls.push("stage-all");
                    },
                },
            }),
        ),
    );
    expect(await client.git.stage({ repo: "root", scope: {} })).toEqual({ ok: true });
    expect(calls).toEqual(["stage-all"]);
});

// After commit, `intent` still shows an untracked file (`commit -a` never sweeps it) and a branch ahead; `spent` is
// clean, so its row is omitted entirely.
test("git.commit answers with the committed repo's post-commit rows, and omits them when nothing is left", async () => {
    const workspace = tempWorkspace([{ name: "intent" }, { name: "spent" }]);
    const left = join(workspace.root, "intent");
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    ...services().git,
                    commitIndex: async () => true,
                    changedFiles: async (dir) =>
                        dir === left
                            ? { branch: "main", conflicted: [], staged: [], unstaged: [{ path: "notes.md", status: "added" }], blobs: new Map() }
                            : { branch: "main", conflicted: [], staged: [], unstaged: [], blobs: new Map() },
                    remoteState: async (dir) =>
                        dir === left ? { remote: "origin", branch: "main", upstream: "origin/main", ahead: 1, behind: 0 } : { ahead: 0, behind: 0 },
                },
                agentOrigins: {
                    forRepo: async (_repo, dir) => (dir === left ? { "notes.md": ["a1"] } : {}),
                    identify: (ids) => Object.fromEntries([...ids].map((id) => [id, { title: "Write notes", provider: "claude" }])),
                    metrics: () => ({}),
                },
            }),
        ),
    );
    expect(await client.git.commit({ repo: "intent", message: "m1" })).toEqual({
        committed: true,
        changes: {
            repo: "intent",
            branch: "main",
            conflicted: [],
            staged: [],
            unstaged: [{ path: "notes.md", status: "added" }],
            remote: { remote: "origin", branch: "main", upstream: "origin/main", ahead: 1, behind: 0 },
            origins: { "notes.md": ["a1"] },
        },
        originAgents: { a1: { title: "Write notes", provider: "claude" } },
    });
    expect(await client.git.commit({ repo: "spent", message: "m2" })).toEqual({ committed: true });
});

// Commit state is server-side because it must survive a reload, a second tab, or a phone, all mid-commit.
test("a running commit rides the changes response, and leaves it when it lands", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    let release: (() => void) | undefined;
    let reached: (() => void) | undefined;
    const inCommit = new Promise<void>((resolve) => {
        reached = resolve;
    });
    const held = new Promise<void>((resolve) => {
        release = resolve;
    });
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    ...services().git,
                    // Non-empty status so `intent` still appears in the response across the commit.
                    changedFiles: async () => ({ branch: "main", conflicted: [], staged: [{ path: "a.ts", status: "modified" }], unstaged: [], blobs: new Map() }),
                    commitIndex: async () => {
                        reached?.();
                        await held;
                        return true;
                    },
                },
            }),
        ),
    );
    const commit = client.git.commit({ repo: "intent", message: "m" });
    await inCommit;
    expect((await client.git.changes()).committing).toEqual(["intent"]);
    release?.();
    await commit;
    // Undefined, not an empty list: absence is the signal the panel re-arms on.
    expect((await client.git.changes()).committing).toBeUndefined();
});

// Serialized here, not gated in the UI: a terminal can commit straight past any UI gate, so the race must be prevented
// on the same per-repo chain `land` uses.
test("git writes serialize per repo, so a commit cannot interleave with an agent's land", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    // Uses worktrees.ts's real chain, not the pass-through other tests use, to exercise actual serialization.
    const chains = new Map<string, Promise<unknown>>();
    const withRepoLock = <T>(repo: string, task: () => Promise<T>): Promise<T> => {
        const chain = chains.get(repo) ?? Promise.resolve();
        const next = chain.then(task, task);
        chains.set(
            repo,
            next.catch(() => undefined),
        );
        return next;
    };
    const order: string[] = [];
    const phase = (entry: string): string | undefined => entry.split(` `)[0];
    const client = clientFor(
        createApp(
            services({
                workspace,
                agentWorktrees: { ...services().agentWorktrees, withRepoLock },
                git: {
                    ...services().git,
                    commitIndex: async (_dir, message) => {
                        order.push(`enter ${message}`);
                        await new Promise((resolve) => setTimeout(resolve, 10));
                        order.push(`exit ${message}`);
                        return true;
                    },
                },
            }),
        ),
    );
    await Promise.all([client.git.commit({ repo: "root", message: "a" }), client.git.commit({ repo: "root", message: "b" })]);
    // Only phase order and membership are checked; race winner between the two commits is not guaranteed.
    expect(order.map(phase)).toEqual([`enter`, `exit`, `enter`, `exit`]);
    expect(new Set(order)).toEqual(new Set([`enter a`, `exit a`, `enter b`, `exit b`]));

    order.length = 0;
    await Promise.all([client.git.commit({ repo: "root", message: "r" }), client.git.commit({ repo: "intent", message: "i" })]);
    // Different repos overlap freely; a workspace-wide lock would defeat the point of per-repo locking.
    expect(order.map(phase)).toEqual([`enter`, `enter`, `exit`, `exit`]);
    expect(new Set(order)).toEqual(new Set([`enter r`, `enter i`, `exit r`, `exit i`]));
});

test("git.discard forwards paths and records the worktree change as a user write", async () => {
    const discards: (readonly string[] | undefined)[] = [];
    let notified = 0;
    const client = clientFor(
        createApp(
            services({
                history: fakeHistory({ notifyUserWrite: () => void notified++ }),
                git: {
                    ...services().git,
                    discardPaths: async (_dir, paths) => {
                        discards.push(paths);
                    },
                },
            }),
        ),
    );
    expect(await client.git.discard({ repo: "root", paths: ["junk.txt"] })).toEqual({ ok: true });
    expect(await client.git.discard({ repo: "root" })).toEqual({ ok: true });
    expect(discards).toEqual([["junk.txt"], undefined]);
    expect(notified).toBe(2);
});

test("git.fileDiff routes each side to its own diff and BAD_REQUESTs a path escape", async () => {
    const client = clientFor(
        createApp(
            services({
                git: {
                    ...services().git,
                    // Staged vs unstaged are distinct comparisons; the clicked row picks which one a partially staged
                    // file uses.
                    stagedFileDiff: async (_dir, path) => (path === "notes.md" ? { before: "one\n", after: "two\n" } : {}),
                    unstagedFileDiff: async (_dir, path) => (path === "notes.md" ? { before: "two\n", after: "three\n" } : {}),
                },
            }),
        ),
    );
    expect(await client.git.fileDiff({ repo: "root", path: "notes.md", side: "staged" })).toEqual({ before: "one\n", after: "two\n" });
    expect(await client.git.fileDiff({ repo: "root", path: "notes.md", side: "unstaged" })).toEqual({ before: "two\n", after: "three\n" });
    expect(await errorCode(client.git.fileDiff({ repo: "root", path: "../escape", side: "staged" }))).toBe("BAD_REQUEST");
});

// capabilities.json is control-plane but `versioned` (git-tracked), so it must stay reviewable; the carve-out is only
// in these two diff routes since the write path stays locked.
test("git.fileDiff serves the tracked control-plane entry and still refuses the rest of it", async () => {
    const diffed: string[] = [];
    const client = clientFor(
        createApp(
            services({
                git: {
                    ...services().git,
                    stagedFileDiff: async (_dir, path) => {
                        diffed.push(path);
                        return { before: "{}\n", after: '{"ssh":{}}\n' };
                    },
                },
            }),
        ),
    );
    expect(await client.git.fileDiff({ repo: "root", path: ".intentic/config/capabilities.json", side: "staged" })).toEqual({
        before: "{}\n",
        after: '{"ssh":{}}\n',
    });
    // These stay untracked, so the `versioned` carve-out never reaches them.
    for (const path of [".intentic/identity/owner.json", ".intentic/secrets/auth/codex/auth.json", ".intentic/local/browser/Default/Cookies"]) {
        expect([path, await errorCode(client.git.fileDiff({ repo: "root", path, side: "staged" }))]).toEqual([path, "NOT_FOUND"]);
    }
    // Even the tracked file stays refused via the generic file API: reading it is review, writing it is not.
    expect(await errorCode(client.git.readFile({ repo: "root", path: ".intentic/config/capabilities.json" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.git.writeFile({ repo: "root", path: ".intentic/config/capabilities.json", content: "{}" }))).toBe("NOT_FOUND");
    expect(diffed).toEqual([".intentic/config/capabilities.json"]);
});

// The peek must not queue behind the repo lock, or a stuck repo would stall the whole panel; abort checkpoints before
// discarding the conflict.
test("git.operation reports a halted repo, and git.abort ends it after checkpointing", async () => {
    const workspace = tempWorkspace([{ name: "app" }]);
    const calls: string[] = [];
    const snapshots: string[] = [];
    let halted: "merge" | "rebase" | "cherry-pick" | "revert" | undefined = "rebase";
    const client = clientFor(
        createApp(
            services({
                workspace,
                history: fakeHistory({
                    snapshot: async (trigger, label) => {
                        snapshots.push(`${trigger} ${label}`);
                        return undefined;
                    },
                }),
                git: {
                    ...services().git,
                    operationInProgress: async (dir) => {
                        calls.push(`peek ${dir}`);
                        return halted;
                    },
                    abortOperation: async (dir, operation) => {
                        calls.push(`abort ${dir} ${operation}`);
                        halted = undefined;
                    },
                },
            }),
        ),
    );

    expect(await client.git.operation({ repo: "app" })).toEqual({ repo: "app", operation: "rebase" });
    expect(await client.git.abort({ repo: "app" })).toEqual({ ok: true });
    expect(snapshots).toEqual(["user before aborting rebase in app"]);
    expect(calls).toEqual([
        `peek ${join(workspace.root, "app")}`,
        `peek ${join(workspace.root, "app")}`,
        `abort ${join(workspace.root, "app")} rebase`,
    ]);

    // A second abort returns a value, not a throw: racing another abort must not surface as a fault.
    expect(await client.git.operation({ repo: "app" })).toEqual({ repo: "app" });
    expect(await client.git.abort({ repo: "app" })).toEqual({ ok: false, reason: "nothing in progress" });
    expect(snapshots).toHaveLength(1);
});

// The peek (`undoable`) must not queue behind the repo lock; `undo` checkpoints first since even a soft undo moves a
// ref the user may need back.
test("git.undoable reports the last action, and git.undo checkpoints before walking the branch back", async () => {
    const workspace = tempWorkspace([{ name: "app" }]);
    const calls: string[] = [];
    const snapshots: string[] = [];
    const action = {
        kind: "rebase" as const,
        description: "rebase (finish): returning to refs/heads/main",
        branch: "main",
        sha: "aaaaaaa",
        previousSha: "bbbbbbb",
        changesWorkingTree: true,
    };
    const client = clientFor(
        createApp(
            services({
                workspace,
                history: fakeHistory({
                    snapshot: async (trigger, label) => {
                        snapshots.push(`${trigger} ${label}`);
                        return undefined;
                    },
                }),
                git: {
                    ...services().git,
                    undoableAction: async (dir) => {
                        calls.push(`peek ${dir}`);
                        return action;
                    },
                    undoLastAction: async (dir, expected, discard) => {
                        calls.push(`undo ${dir} ${expected} ${discard}`);
                        return expected === action.previousSha ? { ok: true as const, action } : { ok: false as const, reason: "stale" };
                    },
                },
            }),
        ),
    );

    expect(await client.git.undoable({ repo: "app" })).toEqual({ repo: "app", action });
    expect(await client.git.undo({ repo: "app", previousSha: "bbbbbbb", discardChanges: true })).toEqual({ ok: true });
    expect(snapshots).toEqual(["user before undo in app"]);

    // A stale undo (position moved past) returns a value, not a throw.
    expect(await client.git.undo({ repo: "app", previousSha: "ccccccc" })).toEqual({ ok: false, reason: "stale" });
    expect(calls).toEqual([
        `peek ${join(workspace.root, "app")}`,
        `undo ${join(workspace.root, "app")} bbbbbbb true`,
        `undo ${join(workspace.root, "app")} ccccccc false`,
    ]);
});
