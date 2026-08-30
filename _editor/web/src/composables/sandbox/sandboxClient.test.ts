import { afterEach, expect, it, vi } from "vitest";

vi.mock("./sandboxSession", () => ({ useSandboxSession: () => ({ getSessionToken: async () => ({ token: `session-token`, kind: `session` }) }) }));
// The real useEndpoint rides on top of this mock: with no loopback shortcut resolved for the sandbox, its
// daemonBase falls through to daemonUrl, which is the behaviour every call here depends on.
vi.mock("./useSandbox", () => ({
    useSandbox: () => ({ active: { value: { token: `connect` } }, activeSandboxId: { value: `s1` }, daemonUrl: { value: `https://daemon.test` } }),
}));

const { sandboxError, sandboxJson } = await import("./sandboxClient");
const { SandboxTimeoutError } = await import("./sandboxAuthFetch");
const { resetDaemonRoutes, setDaemonRoutes } = await import("./useDaemonRoutes");
const { SANDBOX_ROUTE_NAMES, SANDBOX_ROUTE_SHAPES } = await import("@intentic/sandbox-contract");

// A daemon that accepts the request but never answers: settles only when the caller's signal aborts, like
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

/* THE DEADLINE EVERY CALL GETS WHETHER OR NOT ITS CALLER THOUGHT OF ONE, which is the difference between a
 * failure and a workspace that has silently stopped painting. `fetch` has no timeout, so a request that never
 * gets a connection waits for the life of the tab: measured against a real sandbox, reads sat in the browser's
 * queue for 221 seconds while the daemon answered everything else in a mean of 66ms, with no error, no log and
 * no state anywhere saying so. A call that FAILS is one TanStack Query retries; the one that hung was
 * invisible to everything.
 *
 * The real figure is bounded to a few milliseconds by replacing the timer at its source, so this asserts the
 * production path (including the constant it asks for) rather than a shape reconstructed for the test. */
// The global stub is cleared after every test (`unstubAllGlobals` above), so each of these puts the silent
// daemon back before it needs one, and shortens the real deadline at its source rather than reconstructing it.
const hungDaemon = (): ReturnType<typeof vi.spyOn> => {
    vi.stubGlobal(`fetch`, fetchMock);
    const real = AbortSignal.timeout.bind(AbortSignal);
    return vi.spyOn(AbortSignal, `timeout`).mockImplementation(() => real(5));
};

it("bounds a daemon call that never answers, with no signal from the caller at all", async () => {
    const timeout = hungDaemon();
    await expect(sandboxJson(`/settings`)).rejects.toBeInstanceOf(SandboxTimeoutError);
    // The budget is the one this module documents, not whatever a caller happened to pass.
    expect(timeout).toHaveBeenCalledWith(45_000);
    timeout.mockRestore();
});

it("exempts a call that streams a body up: its headers cannot arrive until the upload has", async () => {
    /* A bundle restore is gigabytes and answers nothing until the last byte is sent, so any deadline useful
     * for a READ would abort it partway. The exemption is by body type rather than by route, because it is a
     * property of how the request is sent. */
    const timeout = hungDaemon();
    const settled = sandboxJson(`/bundles/restore`, { method: `POST`, body: new Blob([`archive`]) }).then(
        () => `settled`,
        (error: unknown) => `rejected: ${error instanceof Error ? error.message : String(error)}`,
    );
    const outcome = await Promise.race([settled, new Promise((resolve) => setTimeout(() => resolve(`still uploading`), 50))]);
    expect(outcome).toBe(`still uploading`);
    timeout.mockRestore();
});

// The two skew branches sandboxError adds on top of the daemon's own text. Both only fire on POSITIVE evidence
// from the hello frame: with none, the daemon's message is always the more useful of the two.
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
