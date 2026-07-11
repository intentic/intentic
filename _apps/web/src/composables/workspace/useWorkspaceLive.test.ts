import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryClient } from "../queryPersistence";
import { changeEpochOf, isRecentlyChanged, markWorkspaceChanged } from "./useWorkspaceLive";

// Regression guard: the live-refresh invalidation must work with NO component mounted. It used to ride a
// component-scoped watch behind an install-once flag — the /setup round-trip unmounted the installing shell,
// Vue disposed the watch, and live refresh silently died for the rest of the session.
describe(`markWorkspaceChanged`, () => {
    const key = [`workspace`, `tree`, `filtered`, `sb`];

    beforeEach(() => {
        vi.useFakeTimers();
        queryClient.setQueryData(key, { entries: [] });
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

    it(`tracks per-path epochs and the transient highlight window`, () => {
        const before = changeEpochOf(`b.txt`);
        markWorkspaceChanged([`b.txt`]);
        expect(changeEpochOf(`b.txt`)).toBeGreaterThan(before);
        expect(isRecentlyChanged(`b.txt`)).toBe(true);
        vi.advanceTimersByTime(2001);
        expect(isRecentlyChanged(`b.txt`)).toBe(false);
    });
});
