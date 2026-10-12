// The daemon's member roster is one cache entry the Access tab, the agents board and the credential gates all read, and a
// write answers the roster after it, which lands in that entry whole: nothing keeps a copy, and a reader moves with the write.
import "@intentic/testing/dom";
import { waitFor } from "@intentic/testing/bun";
import { effectScope, type EffectScope, ref } from "vue";

const sandboxJson = jest.fn<(path: string, init?: RequestInit) => Promise<object>>();
jest.mock(`../sandboxClient`, () => ({ sandboxJson: (path: string, init?: RequestInit) => sandboxJson(path, init) }));

const { grantMember, revokeMember, useMembers } = await import(`../useMembers`);
const { signalConnection } = await import(`../useSandbox`);
const { queryClient } = await import(`../../../lib/queryPersistence`);

const reads = (): number => sandboxJson.mock.calls.filter(([path, init]) => path === `/members` && init === undefined).length;

let scope: EffectScope | undefined;
const inScope = <T>(read: () => T): T => {
    scope = effectScope();
    return scope.run(read)!;
};

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

describe(`useMembers`, () => {
    it(`is read once for every surface that names the roster`, async () => {
        sandboxJson.mockResolvedValue({ owner: `owner@example.com`, members: [{ email: `a@example.com`, role: `viewer` }] });
        const [access, gates] = inScope(() => [useMembers(), useMembers()] as const);
        await waitFor(() => expect(gates.owner.value).toBe(`owner@example.com`));
        expect(access.members.value.map((member) => member.email)).toEqual([`a@example.com`]);
        expect(reads()).toBe(1);
    });

    it(`asks only when the reader may: a tier that would be refused never sends the read`, async () => {
        sandboxJson.mockResolvedValue({ members: [] });
        const owner = ref(false);
        const { query } = inScope(() => useMembers({ enabled: owner }));
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(reads()).toBe(0);

        owner.value = true;
        await waitFor(() => expect(query.data.value).toEqual({ members: [] }));
        expect(reads()).toBe(1);
    });

    it(`says why the roster could not be read, and has no roster then`, async () => {
        sandboxJson.mockRejectedValue(new Error(`Request failed (503).`));
        const { error, roster } = inScope(() => useMembers());
        await waitFor(() => expect(error.value).toBe(`Request failed (503).`));
        expect(roster.value).toBeUndefined();
    });
});

describe(`the roster writes`, () => {
    it(`put the roster the daemon answers into the entry, keeping the owner a read found, with no read of their own`, async () => {
        sandboxJson.mockResolvedValue({ owner: `owner@example.com`, members: [] });
        const { roster, members } = inScope(() => useMembers());
        await waitFor(() => expect(roster.value).toEqual({ owner: `owner@example.com`, members: [] }));

        sandboxJson.mockResolvedValue({ members: [{ email: `b@example.com`, role: `guest`, areas: [`support`] }] });
        await grantMember({ email: `b@example.com`, role: `guest`, areas: [`support`] });

        expect(sandboxJson).toHaveBeenCalledWith(`/members`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ email: `b@example.com`, role: `guest`, areas: [`support`] }),
        });
        expect(members.value).toEqual([{ email: `b@example.com`, role: `guest`, areas: [`support`] }]);
        expect(roster.value?.owner).toBe(`owner@example.com`);
        expect(reads()).toBe(1);
    });

    it(`take a revoked person off every reader at once`, async () => {
        sandboxJson.mockResolvedValue({ owner: `owner@example.com`, members: [{ email: `a@example.com`, role: `viewer` }] });
        const [access, board] = inScope(() => [useMembers(), useMembers()] as const);
        await waitFor(() => expect(board.members.value).toHaveLength(1));

        sandboxJson.mockResolvedValue({ members: [] });
        await revokeMember(`a@example.com`);

        expect(sandboxJson).toHaveBeenCalledWith(`/members`, expect.objectContaining({ method: `DELETE`, body: JSON.stringify({ email: `a@example.com` }) }));
        expect([access.members.value, board.members.value]).toEqual([[], []]);
    });

    it(`read the whole roster again when a write lands before any read has, since the answer cannot say who owns it`, async () => {
        const first = Promise.withResolvers<object>();
        sandboxJson.mockReturnValueOnce(first.promise);
        const { roster } = inScope(() => useMembers());

        sandboxJson.mockResolvedValue({ owner: `owner@example.com`, members: [{ email: `c@example.com`, role: `viewer` }] });
        await grantMember({ email: `c@example.com`, role: `viewer` });
        first.resolve({ members: [] });

        await waitFor(() => expect(roster.value?.owner).toBe(`owner@example.com`));
        expect(roster.value?.members).toEqual([{ email: `c@example.com`, role: `viewer` }]);
    });

    it(`are not overwritten by a refresh that was already on its way, which started before the write`, async () => {
        sandboxJson.mockResolvedValue({ owner: `owner@example.com`, members: [] });
        const { roster, query } = inScope(() => useMembers());
        await waitFor(() => expect(roster.value).toEqual({ owner: `owner@example.com`, members: [] }));

        const stale = Promise.withResolvers<object>();
        sandboxJson.mockReturnValueOnce(stale.promise);
        const refreshing = query.refetch();
        sandboxJson.mockResolvedValue({ members: [{ email: `e@example.com`, role: `viewer` }] });
        await grantMember({ email: `e@example.com`, role: `viewer` });
        stale.resolve({ owner: `owner@example.com`, members: [] });
        await refreshing;

        expect(roster.value?.members).toEqual([{ email: `e@example.com`, role: `viewer` }]);
    });

    it(`leave the entry alone when the daemon refuses, and pass the refusal on`, async () => {
        sandboxJson.mockResolvedValue({ owner: `owner@example.com`, members: [] });
        const { members, roster } = inScope(() => useMembers());
        await waitFor(() => expect(roster.value).toEqual({ owner: `owner@example.com`, members: [] }));

        sandboxJson.mockRejectedValue(new Error(`only the owner may grant`));
        await expect(grantMember({ email: `d@example.com`, role: `viewer` })).rejects.toThrow(`only the owner may grant`);
        expect(members.value).toEqual([]);
    });
});
