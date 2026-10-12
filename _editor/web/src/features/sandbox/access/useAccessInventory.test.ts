// The Access tab's "other ways in" counts are narrowed views of cache entries that already exist, each the procedure's own
// (automations, workflows, CI, devices, and the runners list), not reads of their own: opening the tab asks the daemon
// nothing the boards and the Devices view have not just asked, and an unread door is unknown rather than zero.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { effectScope, type EffectScope } from "vue";
import { fakeSandboxRpc } from "../../../testing/sandboxRpcFake";

const unread = async (): Promise<never> => {
    throw new Error(`not answered in this test`);
};
const reads = { automations: jest.fn(), workflows: jest.fn(), ci: jest.fn(), devices: jest.fn(), runners: jest.fn() };
jest.mock(`../../../client/sandbox/sandboxRpc`, () => ({
    sandboxRpc: fakeSandboxRpc({
        automations: { list: () => reads.automations() },
        workflows: { list: () => reads.workflows() },
        ci: { runs: () => reads.ci() },
        system: { devices: () => reads.devices() },
    }),
}));
const sandboxJson = jest.fn<(path: string, init?: RequestInit) => Promise<object>>();
jest.mock(`../../../client/sandbox/sandboxClient`, () => ({ sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init) }));

const { useAccessInventory } = await import(`./useAccessInventory`);
const { signalConnection } = await import(`../../../client/sandbox/useSandbox`);
const { queryClient } = await import(`../../../lib/queryPersistence`);
const { rpcKey } = await import(`../../../lib/queryKeys`);

let scope: EffectScope | undefined;
const inScope = <T>(read: () => T): T => {
    scope = effectScope();
    return scope.run(read)!;
};

const answer = (paired: { devices: number; runners: number }, doors: { webhooks: number; gates: number }) => {
    reads.automations.mockResolvedValue({
        automations: Array.from({ length: doors.webhooks }, () => ({ trigger: { kind: `event` } })).concat([{ trigger: { kind: `cron` } }]),
    });
    reads.workflows.mockResolvedValue({ workflows: [...Array.from({ length: doors.gates }, () => ({ gate: { token: `t` } })), { gate: undefined }] });
    reads.ci.mockResolvedValue({ repos: [{ hookWarning: undefined }, { hookWarning: `no hook` }], runs: [] });
    reads.devices.mockResolvedValue({ devices: Array.from({ length: paired.devices }, (_, index) => ({ key: `d${index}`, label: `d${index}` })) });
    sandboxJson.mockImplementation(async () => ({ runners: Array.from({ length: paired.runners }, (_, index) => ({ id: `r${index}`, online: true, parity: `current` })) }));
};

beforeEach(() => {
    for (const read of Object.values(reads)) {
        read.mockReset();
        read.mockImplementation(unread);
    }
    sandboxJson.mockReset();
    sandboxJson.mockImplementation(unread);
    signalConnection({ kind: `frame`, at: Date.now() });
    queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterEach(() => {
    scope?.stop();
    scope = undefined;
    queryClient.clear();
});

describe(`useAccessInventory`, () => {
    it(`counts each door from the cache entry the boards read, and the paired machines from two of them`, async () => {
        answer({ devices: 2, runners: 1 }, { webhooks: 3, gates: 1 });
        const { inventory, loading } = inScope(() => useAccessInventory());
        await waitFor(() => expect(inventory.value.paired).toEqual({ devices: 2, runners: 1 }));
        expect(inventory.value).toEqual({ webhooks: 3, gates: 1, ciRepos: { total: 2, hooked: 1 }, paired: { devices: 2, runners: 1 } });
        expect(loading.value).toBe(false);
    });

    it(`shares the procedure's entry, whole, rather than keeping a reshaped copy of its own`, async () => {
        answer({ devices: 1, runners: 0 }, { webhooks: 1, gates: 0 });
        const { inventory } = inScope(() => useAccessInventory());
        await waitFor(() => expect(inventory.value.webhooks).toBe(1));
        expect(queryClient.getQueryData<{ automations: object[] }>(rpcKey(`automations.list`))).toEqual({ automations: [{ trigger: { kind: `event` } }, { trigger: { kind: `cron` } }] });
        expect(reads.automations).toHaveBeenCalledTimes(1);
    });

    it(`leaves a door it could not read unknown, and the paired count with it, rather than zero`, async () => {
        answer({ devices: 2, runners: 1 }, { webhooks: 1, gates: 1 });
        reads.devices.mockImplementation(unread);
        const { inventory, loading } = inScope(() => useAccessInventory());
        await waitFor(() => expect(loading.value).toBe(false));
        expect(inventory.value.webhooks).toBe(1);
        expect(inventory.value.paired).toBeUndefined();
    });

    it(`is not loading while the sandbox is not answering, so its doors read as not readable and not as a skeleton`, async () => {
        signalConnection({ kind: `disconnect` });
        const { inventory, loading } = inScope(() => useAccessInventory());
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(loading.value).toBe(false);
        expect(inventory.value).toEqual({});
    });
});
