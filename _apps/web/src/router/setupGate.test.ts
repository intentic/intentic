import type { SandboxSummary } from "@intentic-app/api-contract";
import { describe, expect, it } from "vitest";
import { setupRedirect } from "./setupGate";

const sandbox = (overrides: Partial<SandboxSummary> & Pick<SandboxSummary, "id">): SandboxSummary => ({
    name: overrides.id,
    image: null,
    daemonUrl: null,
    lastSeenAt: null,
    setupCodeClaimedAt: null,
    token: `token-${overrides.id}`,
    role: `owner`,
    providedTunnel: false,
    ...overrides,
});

const CONNECTED = { daemonUrl: `https://box.intentic.dev`, lastSeenAt: `2026-08-02T10:00:00.000Z` } as const;

describe(`setupRedirect`, () => {
    it(`opens the shell for a sandbox that has reported in`, () => {
        expect(setupRedirect([sandbox({ id: `a`, ...CONNECTED })])).toBeUndefined();
    });

    /* The regression this file exists for. /setup creates the row when the name is typed, so a user who names a
     * sandbox and closes the tab owns one that has never had a daemon — and the old `length === 0` test let them
     * back into a workspace shell that could only ever paint "connecting" at a machine nobody started. */
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
        expect(setupRedirect([sandbox({ id: `theirs`, role: `member` })])).toBe(`/setup`);
    });

    it(`resumes the caller's own sandbox rather than a shared one listed before it`, () => {
        expect(setupRedirect([sandbox({ id: `theirs`, role: `member` }), sandbox({ id: `mine` })])).toEqual({
            path: `/setup`,
            query: { sandbox: `mine` },
        });
    });
});
