// A paired-machine roster is one cache entry per door and sandbox: every dialog and row that names these machines reads
// it, the daemon's push of the door's domain refreshes it, and a read that fails is said rather than drawn as no machines.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { staleRuntimeQueryKeys } from "@intentic/sandbox-contract/state/runtime-state";
import { effectScope, type EffectScope } from "vue";
import { SandboxHttpError } from "../../../client/sandbox/sandboxHttpError";

const sandboxJson = jest.fn<(path: string, init?: RequestInit) => Promise<object>>();
jest.mock(`../../../client/sandbox/sandboxClient`, () => ({ sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init) }));

const { HOST_DOOR, PHONE_DOOR, WEBEXT_DOOR, usePeerConnect } = await import(`./usePeerConnect`);
const { signalConnection } = await import(`../../../client/sandbox/useSandbox`);
const { queryClient } = await import(`../../../lib/queryPersistence`);
const { invalidatePushedQueries } = await import(`../../../lib/pushInvalidation`);

const host = (id: string, online: boolean) => ({ id, platform: `linux`, online, environments: [{ key: `native`, online }] });
const roster = (...ids: string[]) => ({ hosts: ids.map((id) => host(id, true)) });

let scope: EffectScope | undefined;
const inScope = <T>(read: () => T): T => {
    scope = effectScope();
    return scope.run(read)!;
};
const reads = (path: string): number => sandboxJson.mock.calls.filter(([called]) => called === path).length;

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

describe(`the roster`, () => {
    it(`is read once for every dialog, row and badge that names the machines`, async () => {
        sandboxJson.mockResolvedValue(roster(`rog`, `omen`));
        const [dialog, board] = inScope(() => [usePeerConnect(HOST_DOOR), usePeerConnect(HOST_DOOR)] as const);
        await waitFor(() => expect(board.peers.value.map((peer) => peer.id)).toEqual([`rog`, `omen`]));
        expect(dialog.peerFor(`omen`)?.online).toBe(true);
        expect(reads(`/system/hosts`)).toBe(1);
    });

    it(`is refreshed by the push of the door's own domain, however the page was opened`, async () => {
        sandboxJson.mockResolvedValue(roster(`rog`));
        const { peers } = inScope(() => usePeerConnect(HOST_DOOR));
        await waitFor(() => expect(peers.value).toHaveLength(1));

        sandboxJson.mockResolvedValue(roster(`rog`, `omen`));
        for (const key of staleRuntimeQueryKeys([`hosts`])) {
            await invalidatePushedQueries(queryClient, { queryKey: [...key] });
        }

        await waitFor(() => expect(peers.value).toHaveLength(2));
        expect(reads(`/system/hosts`)).toBe(2);
    });

    it(`keeps the browsers' and the phones' rosters under keys of their own`, async () => {
        sandboxJson.mockImplementation(async (path) => (path === `/system/webext` ? { browsers: [{ id: `brave`, platform: `windows`, online: true }] } : { phones: [] }));
        const [browsers, phones] = inScope(() => [usePeerConnect(WEBEXT_DOOR), usePeerConnect(PHONE_DOOR)] as const);
        await waitFor(() => expect(browsers.peers.value.map((peer) => peer.id)).toEqual([`brave`]));
        expect(phones.peers.value).toEqual([]);
        expect(reads(`/system/webext`) + reads(`/system/phones`)).toBe(2);

        // A phone connecting moves `phones` and leaves the browsers' read alone.
        for (const key of staleRuntimeQueryKeys([`phones`])) {
            await invalidatePushedQueries(queryClient, { queryKey: [...key] });
        }
        await waitFor(() => expect(reads(`/system/phones`)).toBe(2));
        expect(reads(`/system/webext`)).toBe(1);
    });

    it(`says it could not be read, and keeps the last roster it had`, async () => {
        sandboxJson.mockResolvedValue(roster(`rog`));
        const { peers, rosterNotice } = inScope(() => usePeerConnect(HOST_DOOR));
        await waitFor(() => expect(peers.value).toHaveLength(1));
        expect(rosterNotice.value).toBeUndefined();

        sandboxJson.mockRejectedValue(new SandboxHttpError(503, `The sandbox is starting.`));
        await queryClient.invalidateQueries({ queryKey: [`hosts`] });

        await waitFor(() => expect(rosterNotice.value).toBe(`Couldn't check which machines are connected (The sandbox is starting.).`));
        expect(peers.value.map((peer) => peer.id)).toEqual([`rog`]);
    });
});

describe(`connecting one`, () => {
    it(`mints the pairing for that id, with the code and the moment both lapse`, async () => {
        sandboxJson.mockImplementation(async (path) => (path.startsWith(`/system/hosts/pair`) ? { token: `tok`, code: `ABCD1234`, expiresIn: 600 } : roster()));
        const { connect, pairToken, pairCode, pairExpiresAt, pairId } = inScope(() => usePeerConnect(HOST_DOOR));
        const before = Date.now();
        await connect(`rog`);
        expect(sandboxJson).toHaveBeenCalledWith(`/system/hosts/pair?id=rog`, { method: `POST` });
        expect([pairToken.value, pairCode.value, pairId.value]).toEqual([`tok`, `ABCD1234`, `rog`]);
        expect(pairExpiresAt.value).toBeGreaterThanOrEqual(before + 600_000);
    });

    it(`says who may connect one when the daemon refuses the tier, and why when it fails otherwise`, async () => {
        sandboxJson.mockImplementation(async (path) => {
            if (path.startsWith(`/system/phones/pair`)) {
                throw new SandboxHttpError(403, `forbidden`);
            }
            if (path.startsWith(`/system/hosts/pair`)) {
                throw new SandboxHttpError(500, `boom`);
            }
            return { hosts: [], phones: [] };
        });
        const [phone, device] = inScope(() => [usePeerConnect(PHONE_DOOR), usePeerConnect(HOST_DOOR)] as const);
        await phone.connect(`pixel`);
        expect(phone.error.value).toBe(`Only the sandbox's owner or a maintainer can connect a phone.`);
        await device.connect(`rog`);
        expect(device.error.value).toBe(`Couldn't start the connection (500).`);
        expect(device.pairToken.value).toBeUndefined();
    });

    it(`forgets the token on close, so a stale command cannot be copied`, async () => {
        sandboxJson.mockImplementation(async (path) => (path.startsWith(`/system/hosts/pair`) ? { token: `tok`, expiresIn: 600 } : roster()));
        const { connect, close, pairToken, pairExpiresAt } = inScope(() => usePeerConnect(HOST_DOOR));
        await connect(`rog`);
        close();
        expect([pairToken.value, pairExpiresAt.value]).toEqual([undefined, undefined]);
    });

    it(`reads the roster afresh on open, which a dialog showing a single-use token asks for`, async () => {
        sandboxJson.mockResolvedValue(roster(`rog`));
        const { refresh, peers } = inScope(() => usePeerConnect(HOST_DOOR));
        await waitFor(() => expect(peers.value).toHaveLength(1));
        sandboxJson.mockResolvedValue(roster(`rog`, `omen`));

        await refresh();

        expect(peers.value).toHaveLength(2);
        expect(reads(`/system/hosts`)).toBe(2);
    });
});

describe(`revoking one`, () => {
    it(`drops the enrollment and reads the roster again`, async () => {
        sandboxJson.mockResolvedValue(roster(`rog`));
        const { revoke, peers } = inScope(() => usePeerConnect(HOST_DOOR));
        await waitFor(() => expect(peers.value).toHaveLength(1));
        sandboxJson.mockImplementation(async (path) => (path === `/system/hosts/rog` ? { ok: true } : roster()));

        await revoke(`rog`);

        expect(sandboxJson).toHaveBeenCalledWith(`/system/hosts/rog`, { method: `DELETE` });
        expect(peers.value).toEqual([]);
    });

    it(`throws a refusal, since a revoke that did not take leaves the machine able to connect, and still reads again`, async () => {
        sandboxJson.mockResolvedValue(roster(`rog`));
        const { revoke, peers } = inScope(() => usePeerConnect(HOST_DOOR));
        await waitFor(() => expect(peers.value).toHaveLength(1));
        sandboxJson.mockImplementation(async (path) => {
            if (path === `/system/hosts/rog`) {
                throw new SandboxHttpError(404, `no such device`);
            }
            return roster(`rog`);
        });

        await expect(revoke(`rog`)).rejects.toMatchObject({ status: 404, message: `no such device` });
        expect(reads(`/system/hosts`)).toBe(2);
    });
});
