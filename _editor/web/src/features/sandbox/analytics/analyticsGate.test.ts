import type { SandboxSettings } from "@intentic/sandbox-contract/schemas/settings";
import { nextTick, ref } from "vue";

// The daemon's reachability, flipped by each case; the gate asks for the settings only while it is true.
const reachable = ref(false);
jest.mock("../../../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ reachable }) }));
// The settings read, answered or refused per case, so no request leaves the test.
const fetchSettings = jest.fn<() => Promise<Pick<SandboxSettings, `productAnalytics`>>>();
jest.mock("../../../client/sandbox/rpcQuery", () => ({
    rpcQuery: () => ({ queryKey: [`settings.get`, `gate-test`], queryFn: () => fetchSettings() }),
}));
jest.mock("../../../lib/queryKeys", () => ({ rpcKey: (procedure: string) => [procedure, `gate-test`] }));

const boot = async () => {
    const { activeSandboxId } = await import(`../../../app/storage/activeSandbox`);
    const { queryClient } = await import(`../../../lib/queryPersistence`);
    const { sandboxAnalyticsGate } = await import(`./analyticsGate`);
    activeSandboxId.value = `gate-test`;
    const gate = sandboxAnalyticsGate(ref(`chat`));
    const changed = jest.fn();
    gate.watch(changed);
    return { gate, queryClient, changed };
};

// Lets a settled fetch reach the cache.
const settle = async (): Promise<void> => {
    for (let index = 0; index < 5; index++) {
        await nextTick();
        await Promise.resolve();
    }
};

beforeEach(async () => {
    reachable.value = false;
    fetchSettings.mockReset();
    const { queryClient } = await import(`../../../lib/queryPersistence`);
    queryClient.clear();
});

describe(`sandboxAnalyticsGate`, () => {
    it(`asks for the settings only once the daemon is reachable, then opens`, async () => {
        fetchSettings.mockResolvedValue({ productAnalytics: true });
        const { gate, changed } = await boot();
        expect(gate.permitted(true)).toBe(false);
        expect(fetchSettings).not.toHaveBeenCalled();
        reachable.value = true;
        expect(changed).toHaveBeenCalledTimes(1);
        expect(gate.permitted(true)).toBe(false);
        await settle();
        expect(fetchSettings).toHaveBeenCalledTimes(1);
        expect(gate.permitted(true)).toBe(true);
    });

    // The bug of 2026-10-28: one failed read at boot closed the gate for the page, until a screen that reads the
    // settings (Privacy shield) fetched them.
    it(`asks again after a reconnect when the first read failed`, async () => {
        const { queryClient } = await import(`../../../lib/queryPersistence`);
        const defaults = queryClient.getDefaultOptions();
        // Fails at once rather than after vue-query's three retries.
        queryClient.setDefaultOptions({ ...defaults, queries: { ...defaults.queries, retry: false } });
        fetchSettings.mockRejectedValueOnce(new Error(`waking`)).mockResolvedValue({ productAnalytics: true });
        const { gate } = await boot();
        reachable.value = true;
        gate.permitted(true);
        await settle();
        expect(gate.permitted(true)).toBe(false);
        expect(fetchSettings).toHaveBeenCalledTimes(1);
        reachable.value = false;
        reachable.value = true;
        gate.permitted(true);
        await settle();
        expect(fetchSettings).toHaveBeenCalledTimes(2);
        expect(gate.permitted(true)).toBe(true);
        queryClient.setDefaultOptions(defaults);
    });

    it(`keeps its answer past vue-query's garbage collection, since nothing may observe it`, async () => {
        fetchSettings.mockResolvedValue({ productAnalytics: true });
        const { gate, queryClient } = await boot();
        reachable.value = true;
        gate.permitted(true);
        await settle();
        expect(queryClient.getQueryCache().find({ queryKey: [`settings.get`, `gate-test`] })?.gcTime).toBe(Number.POSITIVE_INFINITY);
    });

    it(`never asks for someone who has not agreed`, async () => {
        const { gate } = await boot();
        reachable.value = true;
        expect(gate.permitted(false)).toBe(false);
        expect(fetchSettings).not.toHaveBeenCalled();
    });
});
