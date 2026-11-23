import "@intentic/testing/dom";
import type { SandboxSummary } from "@intentic/api-contract";
import { sandboxSummary } from "../testing/sandboxSummary";
import { createMemoryHistory, createRouter, type RouteLocationNormalized } from "vue-router";
import { hostedArrival, hostedArrivalPath, hostedEntry, hostedStartRoute } from "./hostedEntry";

// The session and the account's list, answered per case.
const resolveUser = jest.fn();
jest.mock(`./sessionGuard`, () => ({ resolveUser: (to: unknown) => resolveUser(to) }));
const list = jest.fn<() => Promise<readonly SandboxSummary[]>>();
jest.mock(`../client/sandbox/useSandbox`, () => ({ useSandbox: () => ({ list }) }));
// The screen this window last left a sandbox on, which the guard opens it back onto.
jest.mock(`../models/sandbox/sandboxScreen`, () => ({ sandboxEntryPath: (sandboxId: string) => `/s/${sandboxId}/chat/c1` }));

// The cloud entry every "Start in your browser" on intentic.dev links to: it opens the reader's own cloud sandbox when
// they have one, finishes one left unfinished, and otherwise asks Home for a new one on a machine of ours. A returning
// visitor used to be offered a sandbox they could not have instead of the one they had.

const cloud = (over: Partial<SandboxSummary> & Pick<SandboxSummary, `id`>): SandboxSummary =>
    sandboxSummary({ tier: `owner`, hosted: { region: `iad`, warm: true }, lastSeenAt: `2026-11-20T10:00:00Z`, ...over });
const ENTRY = { path: `/start/hosted`, query: {} };

describe(`the cloud entry's decision`, () => {
    it(`asks for a new cloud sandbox when the account has none of its own`, () => {
        const own = sandboxSummary({ id: `laptop`, tier: `owner`, lastSeenAt: `2026-11-20T10:00:00Z` });
        const shared = cloud({ id: `theirs`, tier: `maintainer` });
        expect(hostedArrival([], {})).toEqual({ kind: `create` });
        expect(hostedArrival([own, shared], {})).toEqual({ kind: `create` });
        expect(hostedArrivalPath({ kind: `create` }, ENTRY)).toEqual({ path: `/home`, query: { add: `sandbox`, machine: `hosted` } });
    });

    it(`opens the reader's own cloud sandbox, the one they were in last, rather than offering a second`, () => {
        const older = cloud({ id: `sbx-older-1111`, lastSeenAt: `2026-11-10T10:00:00Z` });
        const newer = cloud({ id: `sbx-newer-2222`, lastSeenAt: `2026-11-21T10:00:00Z` });
        const arrival = hostedArrival([older, newer], {});
        expect(arrival).toEqual({ kind: `open`, sandboxId: `sbx-newer-2222` });
        expect(hostedArrivalPath(arrival, ENTRY)).toMatch(/^\/s\/[^/]+\/agents$/u);
    });

    it(`finishes a cloud sandbox whose setup never finished, on its machine`, () => {
        const unfinished = cloud({ id: `half`, lastSeenAt: null });
        const arrival = hostedArrival([unfinished], {});
        expect(arrival).toEqual({ kind: `finish`, sandboxId: `half` });
        expect(hostedArrivalPath(arrival, ENTRY)).toEqual({ path: `/home`, query: { add: `sandbox`, finish: `half`, machine: `hosted` } });
    });

    it(`prefers one that works over one left unfinished, and skips one whose container was removed`, () => {
        const removed = cloud({ id: `gone`, removedAt: `2026-11-21T10:00:00Z`, lastSeenAt: `2026-11-22T10:00:00Z` });
        expect(hostedArrival([cloud({ id: `half`, lastSeenAt: null }), cloud({ id: `works` }), removed], {})).toEqual({ kind: `open`, sandboxId: `works` });
    });

    // Pricing, and checkout coming back from a sale, name the tier: a purchase must never fall back to the free machine.
    it(`always makes a new machine of the tier an address names`, () => {
        const query = { tier: `standard`, plan: `welcome` };
        expect(hostedArrival([cloud({ id: `free-one` })], query)).toEqual({ kind: `create` });
        expect(hostedArrivalPath({ kind: `create` }, { path: `/start/hosted`, query })).toEqual({
            path: `/home`,
            query: { add: `sandbox`, machine: `hosted`, tier: `standard` },
        });
    });

    it(`stays a named way in, guarded rather than redirected`, () => {
        expect([hostedStartRoute.path, hostedStartRoute.name, `beforeEnter` in hostedStartRoute, `redirect` in hostedStartRoute]).toEqual([
            `/start/hosted`,
            `hosted-start`,
            true,
            false,
        ]);
    });
});

describe(`the cloud entry's guard`, () => {
    const table = createRouter({ history: createMemoryHistory(), routes: [{ path: `/:rest(.*)*`, component: { render: () => null } }] });
    // What a guard is handed: the location a real navigation to the address settles on.
    const at = async (fullPath: string): Promise<RouteLocationNormalized> => {
        await table.push(fullPath);
        return table.currentRoute.value;
    };

    it(`sends a signed-out visitor to sign in, coming back to the entry itself`, async () => {
        const toLogin = { path: `/login`, query: { returnTo: `/start/hosted?profile=default` } };
        resolveUser.mockResolvedValueOnce({ redirect: toLogin, signedOut: true });
        expect(await hostedEntry(await at(`/start/hosted?profile=default`))).toEqual(toLogin);
        expect(list).not.toHaveBeenCalled();
    });

    it(`takes a returning visitor into their cloud sandbox, and a new one to Home's ask`, async () => {
        resolveUser.mockResolvedValue({ user: { id: `u1` } });
        list.mockResolvedValueOnce([cloud({ id: `sbx-mine-3333` })]);
        expect(await hostedEntry(await at(`/start/hosted`))).toBe(`/s/sbx-mine-3333/chat/c1`);
        list.mockResolvedValueOnce([]);
        expect(await hostedEntry(await at(`/start/hosted`))).toEqual({ path: `/home`, query: { add: `sandbox`, machine: `hosted` } });
    });

    it(`lands on Home's ask when the account's list cannot be had`, async () => {
        resolveUser.mockResolvedValue({ user: { id: `u1` } });
        list.mockRejectedValueOnce(new Error(`platform down`));
        expect(await hostedEntry(await at(`/start/hosted`))).toEqual({ path: `/home`, query: { add: `sandbox`, machine: `hosted` } });
    });
});
