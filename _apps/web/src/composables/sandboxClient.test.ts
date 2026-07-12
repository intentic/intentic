import { afterEach, expect, it, vi } from "vitest";

vi.mock("./useGoogleIdentity", () => ({ useGoogleIdentity: () => ({ getIdToken: async () => `id-token` }) }));
vi.mock("./useSandbox", () => ({ useSandbox: () => ({ active: { value: { token: `connect` } }, daemonUrl: { value: `https://daemon.test` } }) }));

const { sandboxJson } = await import("./sandboxClient");

// A daemon that accepts the request but never answers — settles only when the caller's signal aborts, like
// real fetch. Guards the contract ConnectHostCard's mint timeout relies on: a signal in the init reaches
// fetch through sandboxRequest, and its expiry rejects the hung call with a TimeoutError.
const fetchMock = vi.fn(
    (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(`abort`, () => reject(init.signal?.reason as Error));
        }),
);
vi.stubGlobal(`fetch`, fetchMock);

afterEach(() => vi.unstubAllGlobals());

it("a caller-passed timeout signal reaches fetch and rejects the hung request", async () => {
    await expect(sandboxJson(`/system/host-tunnel`, { method: `POST`, signal: AbortSignal.timeout(20) })).rejects.toMatchObject({
        name: `TimeoutError`,
    });
});
