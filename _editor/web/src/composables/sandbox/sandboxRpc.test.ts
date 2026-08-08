import type { SystemEvent } from "@intentic/sandbox-contract";
import { afterEach, expect, it, vi } from "vitest";

const authState = vi.hoisted(() => ({ token: `session-token`, rejected: [] as string[] }));
vi.mock("./sandboxSession", () => ({
    useSandboxSession: () => ({
        getSessionToken: async () => authState.token,
        rejectSessionToken: (_target: unknown, token: string) => {
            authState.rejected.push(token);
            authState.token = `replacement-token`;
        },
    }),
}));
// The real useEndpoint rides on top of this mock: with no loopback shortcut resolved for the sandbox, its
// daemonBase falls through to daemonUrl — which is what keeps every call below aimed at the tunnel.
vi.mock("./useSandbox", () => ({
    useSandbox: () => ({ active: { value: { token: `connect` } }, activeSandboxId: { value: `s1` }, daemonUrl: { value: `https://daemon.test` } }),
}));

const { sandboxRpc, daemonErrorMessage, daemonErrorStatus } = await import("./sandboxRpc");

// The daemon serves /events as an oRPC event iterator, which reaches the browser as text/event-stream. This is
// the exact wire shape @orpc/server's OpenAPIHandler emits — proving the typed client decodes it is the whole
// reason the browser no longer reassembles SSE frames by hand.
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
    // The daemon keys this tab's presence roster entry by clientId, so a GET's input has to survive as a query
    // param — the one thing a typed client could plausibly have changed about this route's wire shape.
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
    // The daemon's hand-written routes answer `{ error }` with a bare status — NOT oRPC's error envelope — so
    // the status has to survive the malformed-response path for the connection machine to classify a 403.
    vi.stubGlobal(
        `fetch`,
        vi.fn(async () => new Response(JSON.stringify({ error: `not a member` }), { status: 403, headers: { "content-type": `application/json` } })),
    );
    const failure = await sandboxRpc.system.events({ clientId: `c1` }).catch((error: unknown) => error);
    expect(daemonErrorStatus(failure)).toBe(403);
    expect(daemonErrorMessage(failure)).toBe(`not a member`);
});

it(`names an unaddressed sandbox as its own condition, before any request goes out`, async () => {
    vi.resetModules();
    vi.doMock("./useSandbox", () => ({
        useSandbox: () => ({ active: { value: undefined }, activeSandboxId: { value: undefined }, daemonUrl: { value: undefined } }),
    }));
    const unaddressed = await import("./sandboxRpc");
    const fetchMock = vi.fn();
    vi.stubGlobal(`fetch`, fetchMock);
    // The re-imported module's own class: vi.resetModules() mints a fresh one, so the outer import's is a
    // different constructor.
    await expect(unaddressed.sandboxRpc.system.info()).rejects.toBeInstanceOf(unaddressed.SandboxUnaddressedError);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.doUnmock("./useSandbox");
});
