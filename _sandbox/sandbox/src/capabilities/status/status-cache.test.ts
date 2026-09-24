import type { CapabilityStatus } from "@intentic/sandbox-contract";
import { waitFor } from "@intentic/testing/bun";
import { createStatusCache } from "./status-cache.js";

// A probe whose next answer the test sets, counting how often it was asked.
const probed = (first: CapabilityStatus) => {
    let answer = first;
    let calls = 0;
    return {
        probe: async (): Promise<CapabilityStatus> => {
            calls += 1;
            return answer;
        },
        answer: (next: CapabilityStatus) => {
            answer = next;
        },
        calls: () => calls,
    };
};

describe(`capability status cache`, () => {
    it(`probes the first ask, then answers from what it holds while a fresh probe runs behind`, async () => {
        const pushes: number[] = [];
        const cache = createStatusCache(() => pushes.push(1), () => undefined);
        const device = probed({ state: `pending`, detail: `away` });
        expect(await cache.status(`phone`, {}, device.probe)).toEqual({ state: `pending`, detail: `away` });
        device.answer({ state: `active` });
        // Served what the last probe found; the probe behind it finds the change and pushes it.
        expect(await cache.status(`phone`, {}, device.probe)).toEqual({ state: `pending`, detail: `away` });
        await waitFor(() => expect(pushes).toHaveLength(1));
        expect(await cache.status(`phone`, {}, device.probe)).toEqual({ state: `active` });
    });

    it(`pushes nothing when the probe behind an answer finds the same one`, async () => {
        const pushes: number[] = [];
        const cache = createStatusCache(() => pushes.push(1), () => undefined);
        const steady = probed({ state: `active` });
        await cache.status(`docker`, {}, steady.probe);
        await cache.status(`docker`, {}, steady.probe);
        await waitFor(() => expect(steady.calls()).toBe(2));
        expect(pushes).toEqual([]);
    });

    it(`probes an edited connection fresh rather than serving what its old settings said`, async () => {
        const cache = createStatusCache(() => undefined, () => undefined);
        const entry = probed({ state: `error`, detail: `bad token` });
        await cache.status(`gitlab`, { token: `old` }, entry.probe);
        entry.answer({ state: `active` });
        expect(await cache.status(`gitlab`, { token: `new` }, entry.probe)).toEqual({ state: `active` });
    });

    it(`keeps the last answer when a probe behind it fails, and forgets a removed connection`, async () => {
        const failures: unknown[] = [];
        const cache = createStatusCache(() => undefined, (error) => failures.push(error));
        await cache.status(`vpn`, {}, async () => ({ state: `active` }));
        expect(
            await cache.status(`vpn`, {}, async () => {
                throw new Error(`probe broke`);
            }),
        ).toEqual({ state: `active` });
        await waitFor(() => expect(failures).toHaveLength(1));
        cache.keepOnly(new Set());
        expect(await cache.status(`vpn`, {}, async () => ({ state: `inactive` }))).toEqual({ state: `inactive` });
    });
});
