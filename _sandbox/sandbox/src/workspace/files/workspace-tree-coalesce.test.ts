import type { WorkspaceTree } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { coalescingWorkspaceTree } from "./workspace-tree-coalesce.js";

// A tree distinguishable by which walk produced it; the shape itself is the walker's business, not this module's.
const treeOf = (marker: string): WorkspaceTree => ({ root: marker, entries: [] }) as unknown as WorkspaceTree;

// A walk that only settles when told to, so "still in flight" is a state the test holds rather than races.
const deferredWalk = (): { walk: (root: string) => Promise<WorkspaceTree>; settle: (marker: string) => void; calls: string[] } => {
    const calls: string[] = [];
    let release: ((tree: WorkspaceTree) => void) | undefined;
    return {
        calls,
        walk: (root: string) => {
            calls.push(root);
            return new Promise<WorkspaceTree>((resolve) => {
                release = resolve;
            });
        },
        settle: (marker: string) => release?.(treeOf(marker)),
    };
};

test("callers arriving mid-walk get that walk, not a second one", async () => {
    const { walk, settle, calls } = deferredWalk();
    const tree = coalescingWorkspaceTree(walk);
    const first = tree("/work");
    const second = tree("/work");
    const third = tree("/work");
    expect(calls).toEqual(["/work"]);
    settle("one");
    expect(await Promise.all([first, second, third])).toEqual([treeOf("one"), treeOf("one"), treeOf("one")]);
});

test("two roots never share a walk", async () => {
    const { walk, calls } = deferredWalk();
    const tree = coalescingWorkspaceTree(walk);
    void tree("/work");
    void tree("/history/worktrees/abc/intentic");
    expect(calls).toEqual(["/work", "/history/worktrees/abc/intentic"]);
});

test("a settled walk answers again inside its window and is re-walked after it", async () => {
    vi.useFakeTimers();
    try {
        let walks = 0;
        const tree = coalescingWorkspaceTree(() => {
            walks += 1;
            return Promise.resolve(treeOf(`walk-${walks}`));
        }, 500);
        expect(await tree("/work")).toEqual(treeOf("walk-1"));
        vi.setSystemTime(Date.now() + 499);
        expect(await tree("/work")).toEqual(treeOf("walk-1"));
        expect(walks).toBe(1);
        // The window is an expiry, not a lease to renew: reuse must not push it forward.
        vi.setSystemTime(Date.now() + 1);
        expect(await tree("/work")).toEqual(treeOf("walk-2"));
        expect(walks).toBe(2);
    } finally {
        vi.useRealTimers();
    }
});

test("a failed walk is not cached, so the next caller retries", async () => {
    let attempts = 0;
    const tree = coalescingWorkspaceTree(() => {
        attempts += 1;
        return attempts === 1 ? Promise.reject(new Error("walk blew up")) : Promise.resolve(treeOf("recovered"));
    });
    await expect(tree("/work")).rejects.toThrow("walk blew up");
    expect(await tree("/work")).toEqual(treeOf("recovered"));
    expect(attempts).toBe(2);
});

// A worktree asked for once must not leave a whole workspace listing held for the process's life. Retention is not
// directly observable, so the assertion is on what the prune is FOR: a walk for one root evicts the expired others,
// and each of them walks again rather than answering from something still held.
test("an expired root's tree is dropped rather than held for the life of the daemon", async () => {
    vi.useFakeTimers();
    try {
        const walked: string[] = [];
        const tree = coalescingWorkspaceTree((root) => {
            walked.push(root);
            return Promise.resolve(treeOf(root));
        }, 500);
        const dead = Array.from({ length: 20 }, (_, i) => `/history/worktrees/gone-${i}/intentic`);
        for (const root of dead) {
            await tree(root);
        }
        vi.setSystemTime(Date.now() + 501);
        await tree("/work");
        walked.length = 0;
        for (const root of dead) {
            await tree(root);
        }
        expect(walked).toEqual(dead);
    } finally {
        vi.useRealTimers();
    }
});
