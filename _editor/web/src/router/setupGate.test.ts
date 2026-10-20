import type { SandboxSummary } from "@intentic/api-contract";
import { readSetupRedirect, setupRedirect } from "./setupGate";

const sandbox = (overrides: Partial<SandboxSummary> & Pick<SandboxSummary, "id">): SandboxSummary => ({
    name: overrides.id,
    image: null,
    daemonUrl: null,
    lastSeenAt: null,
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    hosted: null,
    token: `token-${overrides.id}`,
    role: `owner`,
    providedAddress: false,
    localHostname: null,
    ...overrides,
});

describe(`checking setup before opening the workspace`, () => {
    it.each([
        { name: `an empty cached list`, cached: [] },
        { name: `a cached row that had not checked in yet`, cached: [sandbox({ id: `local` })] },
    ])(`opens a sandbox connected since $name was read`, async ({ cached }) => {
        const refresh = jest.fn(async () => [sandbox({ id: `local`, ...CONNECTED })]);

        expect(await readSetupRedirect({ list: async () => cached, refresh })).toBeUndefined();
        expect(refresh).toHaveBeenCalledTimes(1);
    });

    it(`keeps a sleeping sandbox in the workspace without another platform request`, async () => {
        const refresh = jest.fn(async () => []);
        const asleep = sandbox({ id: `local`, lastSeenAt: CONNECTED.lastSeenAt, daemonUrl: null });

        expect(await readSetupRedirect({ list: async () => [asleep], refresh })).toBeUndefined();
        expect(refresh).not.toHaveBeenCalled();
    });

    it(`resumes the unfinished sandbox in the fresh list`, async () => {
        expect(
            await readSetupRedirect({ list: async () => [], refresh: async () => [sandbox({ id: `pending` })] }),
        ).toEqual({ path: `/setup`, query: { sandbox: `pending` } });
    });

    it(`opens setup once a fresh list confirms there are no sandboxes`, async () => {
        expect(await readSetupRedirect({ list: async () => [sandbox({ id: `removed` })], refresh: async () => [] })).toBe(`/setup`);
    });

    it(`propagates a failed refresh so the router can show the platform outage`, async () => {
        await expect(
            readSetupRedirect({
                list: async () => [],
                refresh: async () => {
                    throw new Error(`platform unavailable`);
                },
            }),
        ).rejects.toThrow(`platform unavailable`);
    });
});

const CONNECTED = { daemonUrl: `https://box.intentic.dev`, lastSeenAt: `2026-08-02T10:00:00.000Z` } as const;

describe(`setupRedirect`, () => {
    it(`opens the shell for a sandbox that has reported in`, () => {
        expect(setupRedirect([sandbox({ id: `a`, ...CONNECTED })])).toBeUndefined();
    });

    /* The regression this file exists for. */
    it(`sends a named-but-never-started sandbox back to its own unfinished setup`, () => {
        expect(setupRedirect([sandbox({ id: `pending` })])).toEqual({ path: `/setup`, query: { sandbox: `pending` } });
    });

    it(`sends an account with no sandboxes at all to a blank setup`, () => {
        expect(setupRedirect([])).toBe(`/setup`);
    });

    // A sandbox that is merely DOWN keeps its stamp: the switcher handles an unreachable daemon, and bouncing
    // the whole shell would strand someone whose container is simply stopped away from their own workspace.
    it(`keeps the shell open for a sandbox that has been up before and is offline now`, () => {
        expect(setupRedirect([sandbox({ id: `a`, daemonUrl: null, lastSeenAt: `2026-07-01T10:00:00.000Z` })])).toBeUndefined();
    });

    it(`accepts one connected sandbox alongside an unfinished one`, () => {
        expect(setupRedirect([sandbox({ id: `pending` }), sandbox({ id: `live`, ...CONNECTED })])).toBeUndefined();
    });

    // A member cannot mint a setup code for someone else's sandbox, so resuming theirs would land them on a
    // step they are not allowed to finish. The blank form still offers the attach lane.
    it(`does not resume a shared sandbox the caller only has access to`, () => {
        expect(setupRedirect([sandbox({ id: `theirs`, role: `collaborator` })])).toBe(`/setup`);
    });

    it(`resumes the caller's own sandbox rather than a shared one listed before it`, () => {
        expect(setupRedirect([sandbox({ id: `theirs`, role: `collaborator` }), sandbox({ id: `mine` })])).toEqual({
            path: `/setup`,
            query: { sandbox: `mine` },
        });
    });
});
