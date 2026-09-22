import { it, expect, beforeEach, afterEach, mock } from "bun:test";
import { stubGlobal, unstubAllGlobals, hoisted } from "@intentic/testing/bun";

// The retry the authenticated fetch owes a refused bearer: once, with the bearer it actually sent blamed and a fresh
// one fetched. Both of the daemon's refusals (401: not taken; 428: taken but short of the passkey rule) earn it;
// nothing else does.

const state = hoisted(() => ({
    bearers: [`first`, `second`] as string[],
    rejected: [] as string[],
}));

mock.module("../session/sandboxSession", () => ({
    useSandboxSession: () => ({
        getSessionToken: async () => {
            const token = state.bearers.shift();
            return token === undefined ? undefined : { token, kind: `session` as const };
        },
        rejectSessionToken: (_target: unknown, bearer: { token: string }) => {
            state.rejected.push(bearer.token);
        },
    }),
}));
mock.module("./useSandbox", () => ({
    useSandbox: () => ({ active: { value: { token: `connect` } }, activeSandboxId: { value: `s1` }, daemonUrl: { value: `https://daemon.test` } }),
}));

const { sandboxAuthenticatedFetch } = await import("./sandboxAuthFetch");

const fetchMock = mock<(request: Request) => Promise<Response>>();
const bearerOf = (call: number): string | null => {
    const request = fetchMock.mock.calls[call]?.[0];
    return request === undefined ? null : request.headers.get(`authorization`);
};

beforeEach(() => {
    state.bearers = [`first`, `second`];
    state.rejected = [];
    fetchMock.mockReset();
    stubGlobal(`fetch`, fetchMock);
});
afterEach(() => unstubAllGlobals());

it.each([401, 428])(`a %i drops the bearer that was sent and retries once with the next`, async (status) => {
    fetchMock.mockResolvedValueOnce(new Response(`refused`, { status })).mockResolvedValueOnce(new Response(`{}`, { status: 200 }));
    const response = await sandboxAuthenticatedFetch(new Request(`https://daemon.test/settings`));
    expect(response.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bearerOf(0)).toBe(`Bearer first`);
    expect(bearerOf(1)).toBe(`Bearer second`);
    expect(state.rejected).toEqual([`first`]);
});

it(`a refusal with no replacement to be had is returned as it came`, async () => {
    state.bearers = [`first`];
    fetchMock.mockResolvedValueOnce(new Response(`refused`, { status: 428 }));
    const response = await sandboxAuthenticatedFetch(new Request(`https://daemon.test/settings`));
    expect(response.status).toBe(428);
    expect(fetchMock).toHaveBeenCalledTimes(1);
});

it(`a 403 is a verdict on the identity, not the bearer: no retry, nothing blamed`, async () => {
    fetchMock.mockResolvedValueOnce(new Response(`forbidden`, { status: 403 }));
    const response = await sandboxAuthenticatedFetch(new Request(`https://daemon.test/settings`));
    expect(response.status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(state.rejected).toEqual([]);
});
