import { rpcKeyAt } from "../../../../lib/queryKeys";
import { queryClient, UNPERSISTED } from "../../../../lib/queryPersistence";
import { changeEpochOf, isRecentlyChanged, markWorkspaceChanged, workspaceChangedSince, workspaceChangeMark } from "./useWorkspaceLive";

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
