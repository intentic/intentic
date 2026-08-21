import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../queryPersistence";
import { changeEpochOf, isRecentlyChanged, markWorkspaceChanged } from "./useWorkspaceLive";

// Regression guard: the live-refresh invalidation must work with NO component mounted. It used to ride a
// component-scoped watch behind an install-once flag: the /setup round-trip unmounted the installing shell,
// Vue disposed the watch, and live refresh silently died for the rest of the session.
describe(`markWorkspaceChanged`, () => {
    const key = [`workspace`, `tree`, `filtered`, `sb`];
    const modulesKey = [`workspace`, `modules`, `sb`];

    beforeEach(() => {
        vi.useFakeTimers();
        queryClient.setQueryData(key, { entries: [] });
        queryClient.setQueryData(modulesKey, { repos: [] });
    });

    afterEach(() => {
        vi.runAllTimers();
        vi.useRealTimers();
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

    /* The package layout the review lists group under. It is held for minutes, so nothing but this push can end
     * a wrong grouping, and the case that makes it wrong (a package created mid-session) is also the case
     * where every one of its files is on screen in the Changes panel at once. */
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
        vi.advanceTimersByTime(2001);
        expect(isRecentlyChanged(`b.txt`)).toBe(false);
    });
});
