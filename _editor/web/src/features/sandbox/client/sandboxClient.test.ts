import { resetSandboxScope } from "@intentic/extension-api";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";

jest.mock("../session/sandboxSession", () => ({
    useSandboxSession: () => ({ getSessionToken: async () => ({ token: `session-token`, kind: `session` }) }),
}));
// The real useEndpoint runs on this mock: with no loopback resolved, daemonBase falls through to daemonUrl.
jest.mock("./useSandbox", () => ({
    useSandbox: () => ({ active: { value: { token: `connect` } }, activeSandboxId: { value: `s1` }, daemonUrl: { value: `https://daemon.test` } }),
}));

const { sandboxError, sandboxJson, sandboxRequest } = await import("./sandboxClient");
const { SandboxTimeoutError } = await import("./sandboxAuthFetch");
const { setDaemonRoutes } = await import("../overview/useDaemonRoutes");
const { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } = await import("@intentic/sandbox-contract");

// A daemon that accepts but never answers; settles only when the caller's signal aborts, like real fetch.
const fetchMock = jest.fn(
    (request: Request) =>
        new Promise<Response>((_resolve, reject) => {
            request.signal.addEventListener(`abort`, () => reject(request.signal.reason as Error));
        }),
);
stubGlobal(`fetch`, fetchMock);

afterEach(() => unstubAllGlobals());

it("a caller-passed timeout signal reaches fetch and rejects the hung request", async () => {
    await expect(sandboxJson(`/system/host-tunnel`, { method: `POST`, signal: AbortSignal.timeout(20) })).rejects.toMatchObject({
        name: `TimeoutError`,
    });
});

// Spies on AbortSignal.timeout to shorten the real deadline at its source, exercising the production constant
// rather than a reconstructed one.
// Restubs fetch since afterEach clears global stubs; shortens the timeout at its source for each test.
const hungDaemon = (): ReturnType<typeof jest.spyOn> => {
    stubGlobal(`fetch`, fetchMock);
    const real = AbortSignal.timeout.bind(AbortSignal);
    return jest.spyOn(AbortSignal, `timeout`).mockImplementation(() => real(5));
};

it("bounds a daemon call that never answers, with no signal from the caller at all", async () => {
    const timeout = hungDaemon();
    await expect(sandboxJson(`/settings`)).rejects.toBeInstanceOf(SandboxTimeoutError);
    // The budget is the one this module documents, not whatever a caller happened to pass.
    expect(timeout).toHaveBeenCalledWith(45_000);
    timeout.mockRestore();
});

it("exempts a call that streams a body up: its headers cannot arrive until the upload has", async () => {
    // Exempted by body type, not by route, since that's the actual mechanism at play.
    const timeout = hungDaemon();
    const settled = sandboxJson(`/arrivals/plan`, { method: `POST`, body: new Blob([`archive`]) }).then(
        () => `settled`,
        (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve(`still uploading`), 50))]);
    expect(outcome).toBe(`still uploading`);
    timeout.mockRestore();
});

// A daemon that answers its headers at once and its body well after the shortened deadline; like real fetch, an abort
// of the request's signal errors a body still being read.
const streamingDaemon = (): ReturnType<typeof jest.spyOn> => {
    stubGlobal(
        `fetch`,
        jest.fn((request: Request) => {
            const body = new ReadableStream<Uint8Array>({
                start(controller) {
                    request.signal.addEventListener(`abort`, () => controller.error(new DOMException(`BodyStreamBuffer was aborted`, `AbortError`)));
                    setTimeout(() => {
                        controller.enqueue(new TextEncoder().encode(`finished`));
                        controller.close();
                    }, 40);
                },
            });
            return Promise.resolve(new Response(body));
        }),
    );
    const real = AbortSignal.timeout.bind(AbortSignal);
    return jest.spyOn(AbortSignal, `timeout`).mockImplementation(() => real(5));
};

it("lets a stream run past the deadline once its headers are in: a device flow takes minutes", async () => {
    const timeout = streamingDaemon();
    const response = await sandboxRequest(`/system/devices/omen/sandboxes/omen`, { method: `POST` });
    expect(await response.text()).toBe(`finished`);
    timeout.mockRestore();
});

// Both extra branches only fire on positive route-drift evidence; with none, the daemon's own message is used.
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status });

afterEach(() => resetSandboxScope());

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
    // Route present, shapes agree: the daemon's own message explains the refusal best.
    setDaemonRoutes([...SANDBOX_ROUTE_NAMES], { ...SANDBOX_ROUTE_SHAPES });
    const error = await sandboxError(json(400, { message: `iqSearchHoldout must be between 0 and 1` }), { method: `POST`, path: `/settings` });
    expect(error.message).toBe(`iqSearchHoldout must be between 0 and 1`);
});

// A path the contract does not declare has no route name, so no drift reading: its refusal is the daemon's own.
it("stays silent about drift for a path outside the contract, like /health", async () => {
    setDaemonRoutes(
        SANDBOX_ROUTE_NAMES.filter((name) => !name.startsWith(`vpn.`)),
        { ...SANDBOX_ROUTE_SHAPES, "settings.get": `different` },
    );
    expect((await sandboxError(json(404, { message: `Not Found` }), { method: `GET`, path: `/health` })).message).toBe(`Not Found`);
    expect((await sandboxError(json(400, { error: `bad path` }), { method: `GET`, path: `/health` })).message).toBe(`bad path`);
});

it("passes a 500 through untouched even on a drifted route", async () => {
    // Drift explains a refused request, not a daemon that crashed handling an accepted one.
    setDaemonRoutes([...SANDBOX_ROUTE_NAMES], { ...SANDBOX_ROUTE_SHAPES, "settings.set": `different` });
    const error = await sandboxError(json(500, { error: `boom` }), { method: `POST`, path: `/settings` });
    expect(error.message).toBe(`boom`);
});
