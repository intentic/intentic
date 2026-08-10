import { afterEach, expect, it, vi } from "vitest";

vi.mock("./sandboxSession", () => ({ useSandboxSession: () => ({ getSessionToken: async () => `session-token` }) }));
// The real useEndpoint rides on top of this mock: with no loopback shortcut resolved for the sandbox, its
// daemonBase falls through to daemonUrl — which is the behaviour every call here depends on.
vi.mock("./useSandbox", () => ({
    useSandbox: () => ({ active: { value: { token: `connect` } }, activeSandboxId: { value: `s1` }, daemonUrl: { value: `https://daemon.test` } }),
}));

const { sandboxError, sandboxJson } = await import("./sandboxClient");
const { resetDaemonRoutes, setDaemonRoutes } = await import("./useDaemonRoutes");
const { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } = await import("@intentic/sandbox-contract");

// A daemon that accepts the request but never answers — settles only when the caller's signal aborts, like
// real fetch. Guards the contract ConnectHost's mint timeout relies on: a signal in the init reaches
// fetch through sandboxRequest, and its expiry rejects the hung call with a TimeoutError.
const fetchMock = vi.fn(
    (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(`abort`, () => reject(request.signal.reason as Error));
        }),
);
vi.stubGlobal(`fetch`, fetchMock);

afterEach(() => vi.unstubAllGlobals());

it("a caller-passed timeout signal reaches fetch and rejects the hung request", async () => {
    await expect(sandboxJson(`/system/host-tunnel`, { method: `POST`, signal: AbortSignal.timeout(20) })).rejects.toMatchObject({
        name: `TimeoutError`,
    });
});

// The two skew branches sandboxError adds on top of the daemon's own text. Both only fire on POSITIVE evidence
// from the hello frame — with none, the daemon's message is always the more useful of the two.
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

afterEach(() => resetDaemonRoutes());

it("blames the image for a 404 on a route the daemon never advertised", async () => {
    setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => !name.startsWith(`vpn.`)));
    const error = await sandboxError(json(404, { message: `Not Found` }), { method: `GET`, path: `/vpn` });
    expect(error.message).toContain(`vpn.list`);
});

it("blames the image for a 400 on a route whose shape the daemon disagrees about", async () => {
    setDaemonRoutes([...SANDBOX_ROUTE_NAMES], { ...SANDBOX_ROUTE_SHAPES, "settings.set": `different` });
    const error = await sandboxError(json(400, { message: `Invalid input` }), { method: `POST`, path: `/settings` });
    expect(error.message).toContain(`settings.set`);
});

it("passes an ordinary 400 through with the daemon's own words", async () => {
    // The route is present and both sides agree on its shape, so the daemon knows best why it refused.
    setDaemonRoutes([...SANDBOX_ROUTE_NAMES], { ...SANDBOX_ROUTE_SHAPES });
    const error = await sandboxError(json(400, { message: `terseHoldout must be between 0 and 1` }), { method: `POST`, path: `/settings` });
    expect(error.message).toBe(`terseHoldout must be between 0 and 1`);
});

it("passes a 500 through untouched even on a drifted route", async () => {
    // Drift explains a REFUSED request, never a daemon that crashed handling an accepted one.
    setDaemonRoutes([...SANDBOX_ROUTE_NAMES], { ...SANDBOX_ROUTE_SHAPES, "settings.set": `different` });
    const error = await sandboxError(json(500, { error: `boom` }), { method: `POST`, path: `/settings` });
    expect(error.message).toBe(`boom`);
});
