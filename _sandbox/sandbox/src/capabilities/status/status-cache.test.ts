import type { CapabilityStatus } from "@intentic/sandbox-contract/schemas/capabilities";
import { waitFor } from "@intentic/testing/bun";
import { createStatusCache, REPROBE_AFTER_MS } from "./status-cache.js";

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
        const cache = createStatusCache({ changed: () => pushes.push(1), onProbeError: () => undefined, reprobeAfterMs: 0 });
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
        const cache = createStatusCache({ changed: () => pushes.push(1), onProbeError: () => undefined, reprobeAfterMs: 0 });
        const steady = probed({ state: `active` });
        await cache.status(`docker`, {}, steady.probe);
        await cache.status(`docker`, {}, steady.probe);
        await waitFor(() => expect(steady.calls()).toBe(2));
        expect(pushes).toEqual([]);
    });

    it(`probes an edited connection fresh rather than serving what its old settings said`, async () => {
        const cache = createStatusCache({ changed: () => undefined, onProbeError: () => undefined });
        const entry = probed({ state: `error`, detail: `bad token` });
        await cache.status(`gitlab`, { token: `old` }, entry.probe);
        entry.answer({ state: `active` });
        expect(await cache.status(`gitlab`, { token: `new` }, entry.probe)).toEqual({ state: `active` });
    });

    it(`keeps the last answer when a probe behind it fails, and forgets a removed connection`, async () => {
        const failures: unknown[] = [];
        const cache = createStatusCache({ changed: () => undefined, onProbeError: (error) => failures.push(error), reprobeAfterMs: 0 });
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

    // A clock the test moves, and a count of announced changes it bumps.
    const world = () => {
        let at = 1_000;
        let moves = 0;
        return {
            now: () => at,
            moved: () => moves,
            pass: (ms: number) => {
                at += ms;
            },
            announce: () => {
                moves += 1;
            },
        };
    };

    it(`probes a held answer again only once REPROBE_AFTER_MS has passed since the last probe settled`, async () => {
        const clock = world();
        const cache = createStatusCache({ changed: () => undefined, onProbeError: () => undefined, now: clock.now, moved: clock.moved });
        const docker = probed({ state: `active` });
        await cache.status(`docker`, {}, docker.probe);
        clock.pass(REPROBE_AFTER_MS - 1);
        await cache.status(`docker`, {}, docker.probe);
        await cache.status(`docker`, {}, docker.probe);
        expect(docker.calls()).toBe(1);
        clock.pass(1);
        await cache.status(`docker`, {}, docker.probe);
        await waitFor(() => expect(docker.calls()).toBe(2));
        // The gap starts again from the probe that just settled.
        await cache.status(`docker`, {}, docker.probe);
        expect(docker.calls()).toBe(2);
    });

    it(`probes behind every read while a status is settling, as something under way moves it on its own`, async () => {
        const clock = world();
        const cache = createStatusCache({ changed: () => undefined, onProbeError: () => undefined, now: clock.now, moved: clock.moved });
        const download = probed({ state: `pending`, detail: `downloading`, settling: true });
        await cache.status(`model`, {}, download.probe);
        await cache.status(`model`, {}, download.probe);
        await waitFor(() => expect(download.calls()).toBe(2));
        download.answer({ state: `active` });
        await cache.status(`model`, {}, download.probe);
        await waitFor(() => expect(download.calls()).toBe(3));
        // Settled now, so the gap holds again.
        await cache.status(`model`, {}, download.probe);
        expect(download.calls()).toBe(3);
    });

    it(`makes every held answer due when a change is announced, and once only`, async () => {
        const clock = world();
        const cache = createStatusCache({ changed: () => undefined, onProbeError: () => undefined, now: clock.now, moved: clock.moved });
        const laptop = probed({ state: `pending`, detail: `the device is offline` });
        await cache.status(`laptop`, {}, laptop.probe);
        laptop.answer({ state: `active` });
        clock.announce();
        expect(await cache.status(`laptop`, {}, laptop.probe)).toEqual({ state: `pending`, detail: `the device is offline` });
        await waitFor(() => expect(laptop.calls()).toBe(2));
        expect(await cache.status(`laptop`, {}, laptop.probe)).toEqual({ state: `active` });
        expect(laptop.calls()).toBe(2);
    });

    it(`probes a connection made due behind its answer, even when the ask arrives while a probe is running`, async () => {
        const clock = world();
        const cache = createStatusCache({ changed: () => undefined, onProbeError: () => undefined, now: clock.now, moved: clock.moved });
        const vpn = probed({ state: `error`, detail: `refused` });
        await cache.status(`vpn`, {}, vpn.probe);
        cache.due(`vpn`);
        let release: () => void = () => undefined;
        const slow = async (): Promise<CapabilityStatus> => {
            await new Promise<void>((resolve) => {
                release = resolve;
            });
            return vpn.probe();
        };
        await cache.status(`vpn`, {}, slow);
        // Asked again while that probe runs: it may have read the connection before the change.
        cache.due(`vpn`);
        release();
        await waitFor(() => expect(vpn.calls()).toBe(2));
        vpn.answer({ state: `active` });
        await cache.status(`vpn`, {}, vpn.probe);
        await waitFor(() => expect(vpn.calls()).toBe(3));
        expect(await cache.status(`vpn`, {}, vpn.probe)).toEqual({ state: `active` });
        expect(vpn.calls()).toBe(3);
    });
});
