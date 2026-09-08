import { REQUEST_ID_EVIDENCE_ROUTE, REQUEST_ID_HEADER, type SystemEvent } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";
import { resetDaemonRoutes, setDaemonRoutes } from "../overview/useDaemonRoutes";

const authState = vi.hoisted(() => ({ token: `session-token`, rejected: [] as string[] }));
vi.mock("./sandboxSession", () => ({
    useSandboxSession: () => ({
        // A bearer names which credential it is, so a 401 can be attributed without re-reading storage.
        getSessionToken: async () => ({ token: authState.token, kind: `session` }),
        rejectSessionToken: (_target: unknown, bearer: { token: string }) => {
            authState.rejected.push(bearer.token);
            authState.token = `replacement-token`;
        },
    }),
}));
// The real useEndpoint runs on this mock: with no loopback resolved, daemonBase falls through to daemonUrl.
vi.mock("./useSandbox", () => ({
    useSandbox: () => ({ active: { value: { token: `connect` } }, activeSandboxId: { value: `s1` }, daemonUrl: { value: `https://daemon.test` } }),
}));

const { sandboxRpc, daemonErrorMessage, daemonErrorStatus } = await import("./sandboxRpc");

// The daemon serves /events as an oRPC event iterator over text/event-stream; this reproduces that exact wire
// shape so the typed client's own decoding is what's under test.
const eventStream = (frames: readonly unknown[]): Response =>
    new Response(frames.map((frame) => `event: message\ndata: ${JSON.stringify(frame)}\n\n`).join(``), {
        status: 200,
        headers: { "content-type": `text/event-stream` },
    });

afterEach(() => vi.unstubAllGlobals());

it(`decodes the daemon's event stream into typed contract frames`, async () => {
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () =>
            eventStream([
                { kind: `hello`, workspaceId: `ws-1`, routes: [`system.info`] },
                { kind: `heartbeat` },
                { kind: `workspaceChanged`, paths: [`src/main.ts`] },
            ]),
        ),
    );
    const received: SystemEvent[] = [];
    for await (const frame of await sandboxRpc.system.events({ clientId: `c1` })) {
        received.push(frame);
    }
    expect(received.map((frame) => frame.kind)).toEqual([`hello`, `heartbeat`, `workspaceChanged`]);
    // Typed, not hand-narrowed: the discriminant is enough to reach a frame's own fields.
    const hello = received[0];
    expect(hello?.kind === `hello` && hello.workspaceId).toBe(`ws-1`);
});

it(`sends the session bearer and the TOFU connect token on the stream request`, async () => {
    authState.token = `session-token`;
    authState.rejected = [];
    const fetchMock = vi.fn(async (_request: Request) => eventStream([{ kind: `heartbeat` }]));
    vi.stubGlobal(`fetch`, fetchMock);
    // One pull is all it takes: what this asserts on is the request that goes out, not the frames that come back.
    await (await sandboxRpc.system.events({ clientId: `c1` }))[Symbol.asyncIterator]().next();
    const request = fetchMock.mock.calls[0]![0];
    expect(request.headers.get(`authorization`)).toBe(`Bearer session-token`);
    expect(request.headers.get(`x-intentic-connect`)).toBe(`connect`);
    expect(request.url).toContain(`https://daemon.test/events`);
    // clientId must survive as a query param on this route; a typed client could otherwise drop it.
    expect(new URL(request.url).searchParams.get(`clientId`)).toBe(`c1`);
});

it(`invalidates and retries exactly once when daemon middleware rejects a session`, async () => {
    authState.token = `session-token`;
    authState.rejected = [];
    const fetchMock = vi
        .fn<(request: Request) => Promise<Response>>()
        .mockResolvedValueOnce(
            new Response(JSON.stringify({ error: `unauthorized` }), { status: 401, headers: { "content-type": `application/json` } }),
        )
        .mockResolvedValueOnce(eventStream([{ kind: `heartbeat` }]));
    vi.stubGlobal(`fetch`, fetchMock);

    await (await sandboxRpc.system.events({ clientId: `c1` }))[Symbol.asyncIterator]().next();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0].headers.get(`authorization`)).toBe(`Bearer session-token`);
    expect(fetchMock.mock.calls[1]?.[0].headers.get(`authorization`)).toBe(`Bearer replacement-token`);
    expect(authState.rejected).toEqual([`session-token`]);
});

it(`surfaces the daemon's status so a refusal can be told from a failure to connect`, async () => {
    // Hand-written routes answer `{ error }` with a bare status, not oRPC's envelope, and it must still survive.
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(JSON.stringify({ error: `not a member` }), { status: 403, headers: { "content-type": `application/json` } })),
    );
    const failure = await sandboxRpc.system.events({ clientId: `c1` }).catch((error: unknown) => error);
    expect(daemonErrorStatus(failure)).toBe(403);
    expect(daemonErrorMessage(failure)).toBe(`not a member`);
});

// A custom header forces a CORS preflight; a daemon that hasn't advertised REQUEST_ID_HEADER in allowHeaders
// fails the whole request, not just the header, so it's only sent once advertised.
it(`withholds the correlation header from a daemon that has not advertised it`, async () => {
    resetDaemonRoutes();
    const fetchMock = vi.fn(async (_request: Request) => eventStream([{ kind: `heartbeat` }]));
    vi.stubGlobal(`fetch`, fetchMock);
    await (await sandboxRpc.system.events({ clientId: `c1` }))[Symbol.asyncIterator]().next();
    expect(fetchMock.mock.calls[0]![0].headers.get(REQUEST_ID_HEADER)).toBeNull();

    // An older daemon that advertises other routes but not this one is still evidence of the wrong thing.
    setDaemonRoutes([`system.info`, `system.events`]);
    await (await sandboxRpc.system.events({ clientId: `c2` }))[Symbol.asyncIterator]().next();
    expect(fetchMock.mock.calls[1]![0].headers.get(REQUEST_ID_HEADER)).toBeNull();
    resetDaemonRoutes();
});

it(`sends the correlation header once the daemon advertises the route that ships with it`, async () => {
    setDaemonRoutes([`system.events`, REQUEST_ID_EVIDENCE_ROUTE]);
    const fetchMock = vi.fn(async (_request: Request) => eventStream([{ kind: `heartbeat` }]));
    vi.stubGlobal(`fetch`, fetchMock);
    await (await sandboxRpc.system.events({ clientId: `c1` }))[Symbol.asyncIterator]().next();
    const sent = fetchMock.mock.calls[0]![0].headers.get(REQUEST_ID_HEADER);
    // The join key the daemon echoes back; only that it's present and distinct per call matters, not its shape.
    expect(sent).toEqual(expect.stringMatching(/\S/));
    await (await sandboxRpc.system.events({ clientId: `c2` }))[Symbol.asyncIterator]().next();
    expect(fetchMock.mock.calls[1]![0].headers.get(REQUEST_ID_HEADER)).not.toBe(sent);
    resetDaemonRoutes();
});

it(`names an unaddressed sandbox as its own condition, before any request goes out`, async () => {
    vi.resetModules();
    vi.doMock("./useSandbox", () => ({
        useSandbox: () => ({ active: { value: undefined }, activeSandboxId: { value: undefined }, daemonUrl: { value: undefined } }),
    }));
    const unaddressed = await import("./sandboxRpc");
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    // vi.resetModules() mints a fresh SandboxUnaddressedError; the outer import's class is a different one.
    await expect(unaddressed.sandboxRpc.system.info()).rejects.toBeInstanceOf(unaddressed.SandboxUnaddressedError);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.doUnmock("./useSandbox");
});
