import { WORKSPACE_ROOT } from "@intentic/constants";
import type { WorkspaceTree, WorkspaceTreeEntry } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { rpcKeyAt } from "../../../lib/queryKeys";
import { queryClient, UNPERSISTED } from "../../../lib/queryPersistence";
import {
    applyTreeChanged,
    changeEpochOf,
    isRecentlyChanged,
    markWorkspaceChanged,
    treeRead,
    workspaceChangedSince,
    workspaceChangeMark,
} from "./useWorkspaceLive";

// Regression guard: the live-refresh invalidation must work with NO component mounted. It used to ride a
// component-scoped watch behind an install-once flag: the /setup round-trip unmounted the installing shell,
// Vue disposed the watch, and live refresh silently died for the rest of the session.
describe(`markWorkspaceChanged`, () => {
    // A conversation's own tree in some box, not the one on screen: the refresh has to reach every scope's copy.
    const key = rpcKeyAt(`sb`, `workspace.tree`, { agent: `c-1` }, UNPERSISTED);
    const modulesKey = rpcKeyAt(`sb`, `workspace.modules`);

    beforeEach(() => {
        jest.useFakeTimers();
        queryClient.setQueryData(key, { entries: [] });
        queryClient.setQueryData(modulesKey, { repos: [] });
    });

    afterEach(() => {
        jest.runAllTimers();
        jest.useRealTimers();
        queryClient.clear();
    });

    it(`invalidates the tree query without any mounted component`, () => {
        markWorkspaceChanged([`a.txt`]);
        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    });

    it(`invalidates on the daemon's empty "just refetch" batch too`, () => {
        markWorkspaceChanged([]);
        expect(queryClient.getQueryState(key)?.isInvalidated).toBe(true);
    });

    /* The package layout the review lists group under. */
    it(`re-reads the package layout when a manifest lands`, () => {
        markWorkspaceChanged([`_libs/new-pkg/package.json`]);
        expect(queryClient.getQueryState(modulesKey)?.isInvalidated).toBe(true);
    });

    it(`re-reads the package layout on the empty "just refetch" batch, which is how a big scaffold arrives`, () => {
        markWorkspaceChanged([]);
        expect(queryClient.getQueryState(modulesKey)?.isInvalidated).toBe(true);
    });

    // The long hold is only affordable because ordinary writes cost nothing: every save must not re-walk every
    // repo. A file merely NAMED like a manifest is an ordinary write.
    it(`leaves the package layout alone for writes that cannot change which packages exist`, () => {
        markWorkspaceChanged([`_libs/new-pkg/src/index.ts`, `docs/my-package.json`]);
        expect(queryClient.getQueryState(modulesKey)?.isInvalidated).toBe(false);
    });

    it(`tracks per-path epochs and the transient highlight window`, () => {
        const before = changeEpochOf(`b.txt`);
        markWorkspaceChanged([`b.txt`]);
        expect(changeEpochOf(`b.txt`)).toBeGreaterThan(before);
        expect(isRecentlyChanged(`b.txt`)).toBe(true);
        jest.advanceTimersByTime(2001);
        expect(isRecentlyChanged(`b.txt`)).toBe(false);
    });

    // A verdict held about the tree (the push flow's refused push) is demoted by the next batch whatever the clock
    // reads: with the clock frozen, a write reported in the verdict's own millisecond still counts as after it. Two
    // millisecond stamps compared with `>` said false here, which is what failed the push flow's test on a fast runner.
    it(`counts a batch in the same millisecond as the verdict as a write since it`, () => {
        jest.setSystemTime(1_000_000);
        markWorkspaceChanged([`c.txt`]);
        const mark = workspaceChangeMark();
        expect(workspaceChangedSince(mark)).toBe(false);
        markWorkspaceChanged([`c.txt`]);
        expect(workspaceChangedSince(mark)).toBe(true);
    });
});

// A whole-tree read answered just before a delta, but landing just after it: the paste it carried vanished from the
// explorer until something else in the workspace moved.
describe(`treeRead`, () => {
    const key = rpcKeyAt(`sb`, `workspace.tree`, { agent: undefined }, UNPERSISTED);
    const entry = (name: string): WorkspaceTreeEntry => ({ name, path: name, type: `file` });
    const tree = (generation: number, names: readonly string[]): WorkspaceTree => ({
        root: WORKSPACE_ROOT,
        tree: names.map(entry),
        hidden: 0,
        barren: [],
        generation,
    });
    // A read held open until the test answers it, as a slow response would be.
    const heldRead = () => {
        let answer: (value: WorkspaceTree) => void = () => undefined;
        const read = treeRead(() => new Promise<WorkspaceTree>((resolve) => (answer = resolve)))({ queryKey: key });
        return { read, answer: (value: WorkspaceTree) => answer(value) };
    };

    afterEach(() => queryClient.clear());

    it(`keeps the tree a delta patched in while the read was out over the older tree the read brings back`, async () => {
        queryClient.setQueryData(key, tree(1, [`a.md`]));
        const { read, answer } = heldRead();
        applyTreeChanged({ from: 1, generation: 2, dirs: [{ path: ``, entries: [entry(`a copy.md`), entry(`a.md`)] }] });
        answer(tree(1, [`a.md`]));
        const kept = await read;
        expect(kept.generation).toBe(2);
        expect(kept.tree.map((listed) => listed.name)).toEqual([`a copy.md`, `a.md`]);
    });

    it(`takes a read that is newer than the patched tree`, async () => {
        queryClient.setQueryData(key, tree(1, [`a.md`]));
        const { read, answer } = heldRead();
        applyTreeChanged({ from: 1, generation: 2, dirs: [{ path: ``, entries: [entry(`a.md`), entry(`b.md`)] }] });
        answer(tree(3, [`a.md`, `b.md`, `c.md`]));
        expect((await read).generation).toBe(3);
    });

    // A restarted daemon counts generations from zero again; with no delta in between, its smaller number is not older.
    it(`takes a read with a smaller generation when no delta landed while it was out`, async () => {
        queryClient.setQueryData(key, tree(40, [`a.md`]));
        const { read, answer } = heldRead();
        answer(tree(0, [`a.md`, `b.md`]));
        expect((await read).generation).toBe(0);
    });
});
