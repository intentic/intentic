// Desktop sync's state is one cache entry with two readers: the badges (`useSyncHealth`) and the Add device card
// (`useDesktopSync`). A daemon that cannot answer reads the same in both, and a failure is said instead of swallowed.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { staleRuntimeQueryKeys } from "@intentic/sandbox-contract/state/runtime-state";
import { effectScope, type EffectScope } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";

const sandboxJson = jest.fn<(path: string, init?: RequestInit) => Promise<object>>();
jest.mock(`../../../client/sandbox/sandboxClient`, () => ({
    sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init),
    sandboxError: jest.fn(),
    sandboxRequest: jest.fn(),
}));
// The streaming verbs and the fleet read beside the sync reads are not what this suite is about.
jest.mock(`./useDevices`, () => ({ manageDeviceSandbox: jest.fn() }));

const { useSyncStatus } = await import(`./useSyncStatus`);
const { useDesktopSync } = await import(`./useDesktopSync`);
const { signalConnection } = await import(`../../../client/sandbox/useSandbox`);
const { queryClient } = await import(`../../../lib/queryPersistence`);
const { invalidatePushedQueries } = await import(`../../../lib/pushInvalidation`);

const status = { enrolled: true, syncing: true, available: true, machines: [] };

let scope: EffectScope | undefined;
const inScope = <T>(read: () => T): T => {
    scope = effectScope();
    return scope.run(read)!;
};
const reads = (): number => sandboxJson.mock.calls.filter(([path]) => path === `/system/sync`).length;

beforeEach(() => {
    sandboxJson.mockReset();
    signalConnection({ kind: `frame`, at: Date.now() });
    queryClient.setDefaultOptions({ queries: { ...queryClient.getDefaultOptions().queries, retry: false } });
});
afterEach(() => {
    scope?.stop();
    scope = undefined;
    queryClient.clear();
});

describe(`useSyncStatus`, () => {
    it(`is one read, however many places draw from it`, async () => {
        sandboxJson.mockResolvedValue(status);
        const [badges, card] = inScope(() => [useSyncStatus(), useDesktopSync()] as const);
        await waitFor(() => expect(badges.status.value?.syncing).toBe(true));
        expect(card.available.value).toBe(true);
        expect(reads()).toBe(1);
    });

    it(`is refreshed by the hosts push, which a sync key made or revoked announces`, async () => {
        sandboxJson.mockResolvedValue({ ...status, syncing: false });
        const { status: current } = inScope(() => useSyncStatus());
        await waitFor(() => expect(current.value?.syncing).toBe(false));

        sandboxJson.mockResolvedValue(status);
        for (const key of staleRuntimeQueryKeys([`hosts`])) {
            await invalidatePushedQueries(queryClient, { queryKey: [...key] });
        }

        await waitFor(() => expect(current.value?.syncing).toBe(true));
        expect(reads()).toBe(2);
    });

    it(`reads an answer that is no answer (an old daemon's 404) as a no, and silence as not known yet`, async () => {
        sandboxJson.mockRejectedValue(new SandboxHttpError(404, `Not Found`));
        const { available } = inScope(() => useDesktopSync());
        expect(available.value).toBeUndefined();
        await waitFor(() => expect(available.value).toBe(false));
    });

    it(`says why it could not be read, and does not call that a daemon with no sync`, async () => {
        sandboxJson.mockRejectedValue(new Error(`tunnel down`));
        const { error, status: current } = inScope(() => useSyncStatus());
        await waitFor(() => expect(error.value).toBe(`tunnel down`));
        expect(current.value).toBeUndefined();
        const { available } = inScope(() => useDesktopSync());
        expect(available.value).toBeUndefined();
    });
});
