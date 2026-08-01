import { join } from "node:path";

import { expect, test } from "vitest";

import { createApp } from "../app.js";

import { clientFor, errorCode, fakeFiles, fakeHistory, services, tempWorkspace } from "../route-testing.js";

/* The git routes, driven over the daemon's HTTP surface exactly as the browser drives them.
 * Split out of app.integration.test.ts, which had grown to 116 tests across every route in the daemon —
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
                            return { branch: "main", conflicted: [], staged: [], unstaged: [{ path: "notes.md", status: "added" as const }] };
                        }
                        if (dir === join(workspace.root, "shop")) {
                            throw new Error("broken repo");
                        }
                        return { conflicted: [], staged: [], unstaged: [] };
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
// verb the graph offers has to resolve it to the workspace root rather than to a dir named "root" — which is
// exactly what the explorer's root git-history icon and the Changes header both open.
test("the git-history graph resolves the 'root' scope to /work — reads, and a HEAD-mover that checkpoints first", async () => {
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
                    commitLog: async (dir, limit) => {
                        calls.push(`log ${dir} ${limit}`);
                        return { branch: "main", commits: [] };
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
    expect(await client.git.log({ repo: "root" })).toEqual({ repo: "root", branch: "main", commits: [] });
    expect(await client.git.commitDiff({ repo: "root", sha: "abcdef1" })).toEqual({ files: [] });
    expect(await client.git.checkout({ repo: "root", ref: "abcdef1" })).toEqual({ ok: true });
    expect(await client.git.log({ repo: "intent" })).toEqual({ repo: "intent", branch: "main", commits: [] });
    expect(calls).toEqual([
        `log ${workspace.root} 300`,
        `commit-diff ${workspace.root} abcdef1`,
        `checkout ${workspace.root} abcdef1`,
        `log ${join(workspace.root, "intent")} 300`,
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
    // A bare message commits exactly the index — the only thing the panel ever asks for, because staging IS
    // how the user chose. There is no path-scoped shape to route to any more.
    expect(await client.git.commit({ repo: "root", message: "m1" })).toEqual({ committed: true });
    expect(await client.git.commit({ repo: "intent", message: "m2", all: true })).toEqual({ committed: true });
    expect(calls).toEqual([`index ${workspace.root} m1`, `all ${join(workspace.root, "intent")} m2`]);
});

// The reason the browser no longer refuses to commit while an agent runs: the ONE thing that was genuinely
// unsafe about it — a commit interleaving with the `git apply` an agent's land performs on the same tree — is
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
    /* One repo, one at a time. The shape is the claim — enter/exit/enter/exit, never two enters in a row — and
     * WHICH of the two won the race to the lock is not something the daemon promises. Pinning a winner here
     * asserted the arrival order of two concurrent round trips, which holds on an idle machine and inverts on
     * a loaded one: a correct serialization failing this was a flake in the test, not in the lock. */
    expect(order.map(phase)).toEqual([`enter`, `exit`, `enter`, `exit`]);
    expect(new Set(order)).toEqual(new Set([`enter a`, `exit a`, `enter b`, `exit b`]));

    order.length = 0;
    await Promise.all([client.git.commit({ repo: "root", message: "r" }), client.git.commit({ repo: "intent", message: "i" })]);
    // Different repos still overlap — both are inside before either leaves. Per-repo is the whole point: a lock
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
