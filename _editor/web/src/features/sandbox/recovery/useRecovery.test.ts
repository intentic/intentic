import type { AdoptionTicket, SandboxLookup, SandboxSummary } from "@intentic/api-contract";
import type { RelinkAnswer, RelinkRequest } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/client";
import { unstubbed } from "@intentic/testing";
import type { RememberedSandbox } from "../../../client/directory/deviceDirectory";
import { type RecoveryDeps, useRecovery } from "./useRecovery";

// Pins the recovery screen's order: probe every remembered sandbox, ask the platform once about the ones that answered,
// sort them (offered back, shared, offline, or let go of), and reconnect one on the owner's press: a session, a ticket,
// the daemon's relink, with the address-only attach for a daemon too old to be adopted.

const remembered = (over: Partial<RememberedSandbox> & Pick<RememberedSandbox, `id` | `daemonUrl`>): RememberedSandbox => ({
    name: over.id,
    image: null,
    role: `owner`,
    hosted: false,
    lastSeenAt: `2026-10-01T18:00:09.479Z`,
    missingSince: `2026-10-02T12:00:00.000Z`,
    ...over,
});

const intentic = remembered({ id: `s1`, name: `intentic`, daemonUrl: `https://sandbox-82789f4106b4.radarsu.com`, image: `data:image/webp;base64,AAAA` });
const notes = remembered({ id: `s2`, daemonUrl: `https://sandbox-574ea8038415.sbx.intentic.dev` });
const shared = remembered({ id: `s3`, role: `writer`, daemonUrl: `https://sandbox-1ea6479e2362.sbx.intentic.dev` });
const custom = remembered({ id: `s4`, daemonUrl: `https://box.example.com` });

const registered: RelinkAnswer = { announce: { state: `registered`, at: 0 } };

const stage = (over: Partial<RecoveryDeps> & { readonly entries: readonly RememberedSandbox[]; readonly standings?: SandboxLookup[`sandboxes`] }) => {
    const forget = jest.fn<(entry: RememberedSandbox) => void>();
    const refreshList = jest.fn<() => Promise<readonly SandboxSummary[]>>(async () => []);
    const relink = jest.fn<(entry: RememberedSandbox, bearer: string, request: RelinkRequest) => Promise<RelinkAnswer | `unsupported`>>(async () => registered);
    const attach = jest.fn<(entry: RememberedSandbox) => Promise<void>>(async () => undefined);
    const lookup = jest.fn<(sandboxIds: readonly string[]) => Promise<SandboxLookup[`sandboxes`]>>(async (ids) =>
        over.standings ?? ids.map((sandboxId) => ({ sandboxId, standing: `unknown` as const })),
    );
    const deps = unstubbed<RecoveryDeps>(`recovery`, {
        candidates: () => over.entries,
        health: async (daemonUrl) => ({ sandboxId: daemonUrl === custom.daemonUrl ? `0123456789ab` : undefined }),
        lookup,
        ticket: async (sandboxId): Promise<AdoptionTicket> => ({ ticket: `at1.${sandboxId}`, expiresAt: `2026-10-02T12:10:00.000Z` }),
        bearer: async () => `daemon-session`,
        relink,
        attach,
        refreshList,
        forget,
        ...over,
    });
    return { recovery: useRecovery(deps), forget, refreshList, relink, attach, lookup };
};

const stateOf = (recovery: ReturnType<typeof useRecovery>) => recovery.candidates.value.map((candidate) => [candidate.entry.id, candidate.state]);

describe(`checking what can be brought back`, () => {
    it(`offers back an answering sandbox of the owner's the platform has no record of, by the id its address carries`, async () => {
        const { recovery, lookup } = stage({ entries: [intentic] });
        await recovery.check();
        expect(stateOf(recovery)).toEqual([[`s1`, { kind: `recoverable`, sandboxId: `82789f4106b4` }]]);
        expect(lookup.mock.calls).toEqual([[[`82789f4106b4`]]]);
        expect(recovery.checked.value).toBe(true);
    });

    it(`asks a sandbox behind a domain of its own for its id`, async () => {
        const { recovery } = stage({ entries: [custom] });
        await recovery.check();
        expect(stateOf(recovery)).toEqual([[`s4`, { kind: `recoverable`, sandboxId: `0123456789ab` }]]);
    });

    it(`names a sandbox that does not answer, and asks the platform nothing about it`, async () => {
        const { recovery, lookup } = stage({ entries: [intentic], health: async () => undefined });
        await recovery.check();
        expect(stateOf(recovery)).toEqual([[`s1`, { kind: `offline` }]]);
        expect(lookup).not.toHaveBeenCalled();
    });

    it(`says a share is its owner's to bring back`, async () => {
        const { recovery } = stage({ entries: [shared] });
        await recovery.check();
        expect(stateOf(recovery)).toEqual([[`s3`, { kind: `shared` }]]);
    });

    it(`lets go of a deleted sandbox and someone else's, and counts one listed after all as back`, async () => {
        const { recovery, forget } = stage({
            entries: [intentic, notes, shared],
            standings: [
                { sandboxId: `82789f4106b4`, standing: `deleted` },
                { sandboxId: `574ea8038415`, standing: `yours`, id: `s9` },
                { sandboxId: `1ea6479e2362`, standing: `other` },
            ],
        });
        await recovery.check();
        expect(stateOf(recovery)).toEqual([[`s2`, { kind: `reconnected`, byAddress: false }]]);
        expect(forget.mock.calls).toEqual([[intentic], [shared]]);
    });

    it(`names a platform that could not be asked, and keeps the sandbox to check again`, async () => {
        const { recovery, forget } = stage({
            entries: [intentic],
            lookup: async () => {
                throw new Error(`network`);
            },
        });
        await recovery.check();
        expect(stateOf(recovery)).toEqual([
            [`s1`, { kind: `failed`, message: `intentic could not be asked about this sandbox: check again in a moment`, sandboxId: `82789f4106b4` }],
        ]);
        expect(forget).not.toHaveBeenCalled();
    });
});

describe(`reconnecting on the owner's press`, () => {
    it(`has the daemon relink with a ticket and what this device remembers of it, then reads the list again`, async () => {
        const { recovery, relink, refreshList } = stage({ entries: [intentic] });
        await recovery.check();
        await recovery.reconnect(intentic, `82789f4106b4`);
        expect(relink.mock.calls).toEqual([[intentic, `daemon-session`, { ticket: `at1.82789f4106b4`, name: `intentic`, image: `data:image/webp;base64,AAAA` }]]);
        expect(refreshList).toHaveBeenCalledTimes(1);
        expect(stateOf(recovery)).toEqual([[`s1`, { kind: `reconnected`, byAddress: false }]]);
    });

    it(`sends no logo it does not remember`, async () => {
        const { recovery, relink } = stage({ entries: [notes] });
        await recovery.check();
        await recovery.reconnect(notes, `574ea8038415`);
        expect(relink.mock.calls[0]?.[2]).toEqual({ ticket: `at1.574ea8038415`, name: `s2` });
    });

    it(`records only the address of a daemon too old to be adopted`, async () => {
        const { recovery, attach } = stage({ entries: [intentic], relink: async () => `unsupported` });
        await recovery.check();
        await recovery.reconnect(intentic, `82789f4106b4`);
        expect(attach.mock.calls).toEqual([[intentic]]);
        expect(stateOf(recovery)).toEqual([[`s1`, { kind: `reconnected`, byAddress: true }]]);
    });

    it(`records only the address on a platform that cannot vouch for sandboxes`, async () => {
        const { recovery, attach, relink } = stage({
            entries: [intentic],
            ticket: async () => {
                throw new ORPCError(`PRECONDITION_FAILED`, { message: `this platform hands out no addresses` });
            },
        });
        await recovery.check();
        await recovery.reconnect(intentic, `82789f4106b4`);
        expect(attach.mock.calls).toEqual([[intentic]]);
        expect(relink).not.toHaveBeenCalled();
    });

    it(`counts a sandbox the platform lists already as back, without relinking it`, async () => {
        const { recovery, relink } = stage({
            entries: [intentic],
            ticket: async () => {
                throw new ORPCError(`CONFLICT`, { message: `this sandbox is already in your list` });
            },
        });
        await recovery.check();
        await recovery.reconnect(intentic, `82789f4106b4`);
        expect(stateOf(recovery)).toEqual([[`s1`, { kind: `reconnected`, byAddress: false }]]);
        expect(relink).not.toHaveBeenCalled();
    });

    it(`passes on the platform's refusal of the adoption, ready to try again`, async () => {
        const refusal: RelinkAnswer = {
            announce: { state: `rejected`, reason: `unknown`, retrying: true, at: 0 },
            adoption: { status: 410, detail: `this sandbox was deleted from intentic: restore it from the trash, or set up a new one` },
        };
        const { recovery } = stage({ entries: [intentic], relink: async () => refusal });
        await recovery.check();
        await recovery.reconnect(intentic, `82789f4106b4`);
        expect(stateOf(recovery)).toEqual([
            [`s1`, { kind: `failed`, message: `this sandbox was deleted from intentic: restore it from the trash, or set up a new one`, sandboxId: `82789f4106b4` }],
        ]);
    });

    it(`asks for a Google sign-in rather than relinking without one`, async () => {
        const { recovery, relink } = stage({ entries: [intentic], bearer: async () => undefined });
        await recovery.check();
        await recovery.reconnect(intentic, `82789f4106b4`);
        expect(stateOf(recovery)).toEqual([[`s1`, { kind: `failed`, message: `sign in with Google to reconnect it`, sandboxId: `82789f4106b4` }]]);
        expect(relink).not.toHaveBeenCalled();
    });

    it(`reconnects every sandbox it offers, one at a time, and leaves the rest`, async () => {
        const order: string[] = [];
        const { recovery } = stage({
            entries: [intentic, notes, shared],
            relink: async (entry) => {
                order.push(entry.id);
                return registered;
            },
        });
        await recovery.check();
        expect(recovery.recoverable.value).toBe(2);
        await recovery.reconnectAll();
        expect(order).toEqual([`s1`, `s2`]);
        expect([recovery.recoverable.value, recovery.reconnected.value]).toEqual([0, 2]);
        expect(stateOf(recovery)[2]).toEqual([`s3`, { kind: `shared` }]);
    });

    it(`forgets a sandbox on the reader's word`, async () => {
        const { recovery, forget } = stage({ entries: [intentic], health: async () => undefined });
        await recovery.check();
        recovery.forget(intentic);
        expect(recovery.candidates.value).toEqual([]);
        expect(forget.mock.calls).toEqual([[intentic]]);
    });
});
