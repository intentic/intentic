import { join } from "node:path";

import { expect, test } from "vitest";

import { createApp } from "../app.js";

import { clientFor, errorCode, fakeFiles, fakeHistory, services, tempWorkspace } from "../route-testing.js";

/* The git routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon:
 * one file that two agents working on unrelated features collided in every time. The fakes and the client
 * are shared (route-testing.ts); what lives here is what these routes do. */

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
    // A clean repo drops out; a broken one stays in the response carrying git's reason, so a repo left torn by a
    // canceled upload is something the panel can show rather than a repo that silently vanished.
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

// The graph's own routes, over the scope that has no directory of its own: "root" IS the /work repo, so every
// verb the graph offers has to resolve it to the workspace root rather than to a dir named "root", which is
// exactly what the explorer's root git-history icon and the Changes header both open.
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
    // A HEAD-mover checkpoints BEFORE it runs for root too, so a checkout off the workspace repo stays
    // reversible from the Checkpoints timeline.
    expect(snapshots).toEqual(["user before checkout abcdef1"]);
    expect(await errorCode(client.git.log({ repo: "nope" }))).toBe("NOT_FOUND");
});

test("git.commit records the index by default and stages everything first for `all`", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    const calls: string[] = [];
    const client = clientFor(
        createApp(
            services({
                workspace,
                git: {
                    ...services().git,
                    commitAll: async (dir, message) => {
                        calls.push(`all ${dir} ${message}`);
                        return true;
                    },
                    commitIndex: async (dir, message) => {
                        calls.push(`index ${dir} ${message}`);
                        return true;
                    },
                },
            }),
        ),
    );
    // A bare message commits exactly the index: the only thing the panel ever asks for, because staging IS
    // how the user chose. There is no path-scoped shape to route to any more.
    expect(await client.git.commit({ repo: "root", message: "m1" })).toEqual({ committed: true });
    expect(await client.git.commit({ repo: "intent", message: "m2", all: true })).toEqual({ committed: true });
    expect(calls).toEqual([`index ${workspace.root} m1`, `all ${join(workspace.root, "intent")} m2`]);
});

/* The commit answers with the repo it just wrote, so the panel replaces one repo's rows instead of firing the
 * workspace-wide rescan it used to: the read that made "I clicked Commit" take seconds while the user watched
 * the rows they had just committed sit there.
 *
 * Both halves of the inclusion rule are the claim. A repo with work LEFT (here an untracked file, which
 * `commit -a` never sweeps, and a branch now one commit ahead) comes back with its row so the panel can redraw
 * it; a repo with nothing left comes back WITHOUT one, which is how the panel knows to drop the group rather
 * than leave an empty one behind. The clean case is the same `undefined` the workspace scan filters on, decided
 * in the same place, so the two can't disagree about what a repo showing nothing means. */
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
        // Only the agents THIS repo names: the panel merges them over what the other repos' rows already
        // carry, rather than replacing a map the one-repo answer cannot have covered.
        originAgents: { a1: { title: "Write notes", provider: "claude" } },
    });
    // Clean tree, no remote work: the row is gone, and saying so is the whole point, the panel drops the group
    // on this answer instead of waiting for a scan to stop listing it.
    expect(await client.git.commit({ repo: "spent", message: "m2" })).toEqual({ committed: true });
});

/* WHO IS COMMITTING, ON THE REVIEW ITSELF: the fact a browser cannot hold on its own.
 *
 * A commit outlives the tab that fired it. Reload mid-commit and that tab's busy flag went with the page: the
 * button re-armed over rows the commit was already recording, and the rows then changed under the user a second
 * later with nothing having said why. Answering it from the daemon is what makes a reload, a second tab and a
 * phone agree, and the clearing half is as load-bearing as the setting half, since a panel that latched on
 * "Committing…" with no way out would be the worse bug. */
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
                    // Something to review, so the repos stay in the response either side of the commit.
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
    // Asked WHILE git is inside the commit: the exact request a reloaded page makes.
    expect((await client.git.changes()).committing).toEqual(["intent"]);
    release?.();
    await commit;
    // Absent, not empty: nothing is committing, and the panel re-arms off exactly this.
    expect((await client.git.changes()).committing).toBeUndefined();
});

// The reason the browser no longer refuses to commit while an agent runs: the ONE thing that was genuinely
// unsafe about it (a commit interleaving with the `git apply` an agent's land performs on the same tree) is
// prevented here instead, on the same per-repo chain `land` already takes. A UI gate could only guess at this
// race; the terminal commits straight past one anyway.
test("git writes serialize per repo, so a commit cannot interleave with an agent's land", async () => {
    const workspace = tempWorkspace([{ name: "intent" }]);
    // The real chain from worktrees.ts rather than the pass-through the other tests use, so this exercises the
    // actual serialization.
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
    /* One repo, one at a time. The shape is the claim: enter/exit/enter/exit, never two enters in a row, and
     * WHICH of the two won the race to the lock is not something the daemon promises. Pinning a winner here
     * asserted the arrival order of two concurrent round trips, which holds on an idle machine and inverts on
     * a loaded one: a correct serialization failing this was a flake in the test, not in the lock. */
    expect(order.map(phase)).toEqual([`enter`, `exit`, `enter`, `exit`]);
    expect(new Set(order)).toEqual(new Set([`enter a`, `exit a`, `enter b`, `exit b`]));

    order.length = 0;
    await Promise.all([client.git.commit({ repo: "root", message: "r" }), client.git.commit({ repo: "intent", message: "i" })]);
    // Different repos still overlap, both are inside before either leaves. Per-repo is the whole point: a lock
    // that spanned the workspace would be the daemon reinventing the workspace-wide block this design removed.
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
                    // Two distinct comparisons, not one HEAD↔worktree diff dressed up twice: for a partially
                    // staged file the row the user clicked is the only thing that says which one they meant.
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

/* THE PANEL MUST BE ABLE TO OPEN EVERY ROW IT DRAWS. `changes` lists what git reports, and the root repo tracks
 * `.intentic/config/capabilities.json` (it is `versioned`: connecting this sandbox to a device or an orchestrator is
 * the largest change made to what it can do, and that belongs in review). The path is also control-plane, so the
 * diff guard used to refuse it and the row 404'd on click: a file deliberately made reviewable, with no way to
 * review it. The lock is about the WRITE, which is why only these two diff routes carve it out. */
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
    // The credentials, the identity binding and the private runtime state are untracked and stay unreachable:
    // the carve-out follows `versioned`, so it cannot widen without the flag that puts a file in `git log`.
    for (const path of [".intentic/identity/owner.json", ".intentic/secrets/auth/codex/auth.json", ".intentic/local/browser/Default/Cookies"]) {
        expect([path, await errorCode(client.git.fileDiff({ repo: "root", path, side: "staged" }))]).toEqual([path, "NOT_FOUND"]);
    }
    // …and the generic file API keeps refusing all of them, the tracked one included: reading a diff is review,
    // writing this file would be granting a capability the owner never approved.
    expect(await errorCode(client.git.readFile({ repo: "root", path: ".intentic/config/capabilities.json" }))).toBe("NOT_FOUND");
    expect(await errorCode(client.git.writeFile({ repo: "root", path: ".intentic/config/capabilities.json", content: "{}" }))).toBe("NOT_FOUND");
    expect(diffed).toEqual([".intentic/config/capabilities.json"]);
});

/* THE WAY OUT OF A HALTED REPO. Nothing this daemon starts can leave one: every sequence verb aborts itself on
 * failure, so both of these exist for what a terminal left behind, and both are worth pinning: the read must
 * not queue behind the repo lock (a stuck repo would become a stuck panel), and the abort must checkpoint before
 * it throws the conflict resolution away. */
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
    // The checkpoint lands BEFORE the abort, because the conflict resolution being discarded is real work.
    expect(snapshots).toEqual(["user before aborting rebase in app"]);
    expect(calls).toEqual([
        `peek ${join(workspace.root, "app")}`,
        `peek ${join(workspace.root, "app")}`,
        `abort ${join(workspace.root, "app")} rebase`,
    ]);

    // Now that it has ended, the repo reports clean and a second Abort is a value rather than a throw: two
    // people on the same repo is ordinary, and the loser of that race should not see a stack trace.
    expect(await client.git.operation({ repo: "app" })).toEqual({ repo: "app" });
    expect(await client.git.abort({ repo: "app" })).toEqual({ ok: false, reason: "nothing in progress" });
    expect(snapshots).toHaveLength(1);
});

/* The undo pair. The read must not queue behind the repo lock (a toolbar renders it), and the write must
 * checkpoint before it moves the branch: a hard undo throws the worktree away, and even a soft one moves a ref
 * the user may have to get back to. */
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

    // An undo prepared against a position the repo has moved past comes back as a value, not a throw: the user
    // is told their view was stale rather than shown a fault.
    expect(await client.git.undo({ repo: "app", previousSha: "ccccccc" })).toEqual({ ok: false, reason: "stale" });
    expect(calls).toEqual([
        `peek ${join(workspace.root, "app")}`,
        `undo ${join(workspace.root, "app")} bbbbbbb true`,
        `undo ${join(workspace.root, "app")} ccccccc false`,
    ]);
});
