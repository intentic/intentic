import { waitFor } from "@intentic/testing/bun";
import type { SandboxSummary } from "@intentic/api-contract";
import { nextTick, ref } from "vue";
import { sandboxSummary } from "../../../testing/sandboxSummary";

// A sandbox asleep on its own computer was read every tick, and every read failed: a request down a tunnel that was not
// there, a list refresh after it, and a "not answering" line for a box that had only gone to sleep (2026-10-29).

const sandboxes = ref<SandboxSummary[]>([]);
const activeSandboxId = ref<string | undefined>(`here`);
const list = jest.fn(async () => sandboxes.value);
jest.mock("../../../client/sandbox/useSandbox", () => ({ useSandbox: () => ({ sandboxes, activeSandboxId, list }) }));
jest.mock("../../../client/sandbox/reachability", () => ({ noteUnreachable: jest.fn() }));
jest.mock("../../../workbench/window/onScreen", () => ({ onScreen: ref(true) }));

const { awaitAnswer, createAcrossStore } = await import("./acrossSandboxes");

const seen = `2026-10-29T09:00:00.000Z`;
const awake = (id: string): SandboxSummary => sandboxSummary({ id, lastSeenAt: seen, sleep: null });
const asleep = (id: string): SandboxSummary => sandboxSummary({ id, lastSeenAt: seen, sleep: { heardAt: seen, wakeable: true } });

interface Box {
    readonly sandbox: SandboxSummary;
    readonly readAt: number | undefined;
    readonly answered?: boolean;
}

const storeWith = (read: (sandbox: SandboxSummary) => Promise<Partial<Box>>) =>
    createAcrossStore<Box>({
        pollMs: 3_600_000,
        freshMs: 0,
        blank: (sandbox) => ({ sandbox, readAt: undefined }),
        read,
        unreachable: () => ({}),
    });

beforeEach(() => {
    list.mockClear();
    activeSandboxId.value = `here`;
    sandboxes.value = [awake(`here`), awake(`desk`), asleep(`laptop`)];
});

describe(`a sandbox the list says sleeps`, () => {
    it(`is not read until the list says it woke, while the others are`, async () => {
        const read = jest.fn(async (_sandbox: SandboxSummary) => ({}));
        const store = storeWith(read);
        const release = store.subscribe();
        await waitFor(() => expect(read).toHaveBeenCalledTimes(1));
        expect(read.mock.calls.map(([sandbox]) => sandbox.id)).toEqual([`desk`]);
        sandboxes.value = [awake(`here`), awake(`desk`), awake(`laptop`)];
        await waitFor(() => expect(read.mock.calls.map(([sandbox]) => sandbox.id)).toContain(`laptop`));
        release();
    });

    it(`is read when a caller names it, a Wake press`, async () => {
        const read = jest.fn(async (_sandbox: SandboxSummary) => ({}));
        const store = storeWith(read);
        await store.readOne(`laptop`);
        expect(read.mock.calls.map(([sandbox]) => sandbox.id)).toEqual([`laptop`]);
        expect(store.get(`laptop`)?.answered).toBe(true);
    });

    it(`is read when it comes back into view, switched away from, whatever the list still says`, async () => {
        activeSandboxId.value = `laptop`;
        const read = jest.fn(async (_sandbox: SandboxSummary) => ({}));
        const store = storeWith(read);
        const release = store.subscribe();
        // The two it stands beside: `here` and `desk`.
        await waitFor(() => expect(read).toHaveBeenCalledTimes(2));
        activeSandboxId.value = `here`;
        await nextTick();
        await waitFor(() => expect(read.mock.calls.map(([sandbox]) => sandbox.id)).toContain(`laptop`));
        release();
    });

    it(`is still read while it answers here, and left alone from its first failure`, async () => {
        let up = true;
        const read = jest.fn(async (sandbox: SandboxSummary) => {
            if (sandbox.id === `laptop` && !up) {
                throw new Error(`no tunnel`);
            }
            return {};
        });
        const store = storeWith(read);
        await store.readOne(`laptop`);
        up = false;
        const release = store.subscribe();
        await waitFor(() => expect(store.get(`laptop`)?.answered).toBe(false));
        const reads = read.mock.calls.length;
        store.refresh();
        await waitFor(() => expect(read.mock.calls.length).toBeGreaterThan(reads));
        expect(read.mock.calls.slice(reads).map(([sandbox]) => sandbox.id)).toEqual([`desk`]);
        release();
    });
});

describe(`awaitAnswer`, () => {
    it(`reads a waking sandbox until it answers`, async () => {
        let tries = 0;
        const store = storeWith(async () => {
            tries += 1;
            if (tries < 3) {
                throw new Error(`still starting`);
            }
            return {};
        });
        expect(await awaitAnswer(store, `laptop`, { everyMs: 1, withinMs: 1_000 })).toBe(true);
        expect(tries).toBe(3);
    });

    it(`gives up once its patience is spent`, async () => {
        const store = storeWith(async () => {
            throw new Error(`asleep`);
        });
        expect(await awaitAnswer(store, `laptop`, { everyMs: 5, withinMs: 12 })).toBe(false);
    });
});
