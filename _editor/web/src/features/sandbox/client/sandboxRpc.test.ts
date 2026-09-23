import { resetSandboxScope } from "@intentic/extension-api";
import {
    REQUEST_ID_EVIDENCE_ROUTE,
    REQUEST_ID_HEADER,
    SANDBOX_ROUTE_NAMES,
    SANDBOX_ROUTE_SHAPES,
    SandboxSettingsSchema,
    type SystemEvent,
} from "@intentic/sandbox-contract";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { readFailure, setDaemonRoutes } from "../overview/useDaemonRoutes";
import { SandboxHttpError } from "./sandboxHttpError";
import { ref } from "vue";

const authState = {
    token: `session-token` as string | undefined,
    rejected: [] as string[],
    // What each ask for a credential said about who is waiting, and which box it was for.
    asked: [] as { base: string; background: boolean | undefined }[],
};
jest.mock("../session/sandboxSession", () => ({
    useSandboxSession: () => ({
        // A bearer names which credential it is, so a 401 can be attributed without re-reading storage.
        getSessionToken: async (target: { base: string }, options?: { background?: boolean }) => {
            authState.asked.push({ base: target.base, background: options?.background });
            return authState.token === undefined ? undefined : { token: authState.token, kind: `session` };
        },
        rejectSessionToken: (_target: unknown, bearer: { token: string }) => {
            authState.rejected.push(bearer.token);
            authState.token = `replacement-token`;
        },
    }),
}));
// The real useEndpoint runs on this mock: with no loopback resolved, daemonBase falls through to daemonUrl.
// Refs, not plain holders, because `daemonBase` is a computed built once at useEndpoint's load: the last case
// unaddresses the sandbox in place, a jest.mock being file-wide and permanent. `s2` is another box this browser
// knows, reached through its own address and connect token.
const sandbox = {
    active: ref<{ token: string } | undefined>({ token: `connect` }),
    activeSandboxId: ref<string | undefined>(`s1`),
    daemonUrl: ref<string | undefined>(`https://daemon.test`),
    sandboxes: ref([{ id: `s2`, daemonUrl: `https://other.test`, token: `other-connect`, role: `member`, hosted: null }]),
};
jest.mock("./useSandbox", () => ({ useSandbox: () => sandbox }));

const { sandboxRpc, gatedSandboxRpc, daemonErrorMessage, daemonErrorStatus } = await import("./sandboxRpc");
const { SandboxUnaddressedError } = await import("./sandboxAuthFetch");

// The daemon serves /events as an oRPC event iterator over text/event-stream; this reproduces that exact wire
// shape so the typed client's own decoding is what's under test.
const eventStream = (frames: readonly unknown[]): Response =>
    new Response(frames.map((frame) => `event: message\ndata: ${JSON.stringify(frame)}\n\n`).join(``), {
        status: 200,
        headers: { "content-type": `text/event-stream` },
    });

afterEach(() => unstubAllGlobals());

it(`decodes the daemon's event stream into typed contract frames`, async () => {
    stubGlobal(
        `fetch`,
        jest.fn(async () =>
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
    const fetchMock = jest.fn(async (_request: Request) => eventStream([{ kind: `heartbeat` }]));
    stubGlobal(`fetch`, fetchMock);
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
    const fetchMock = jest
        .fn<(request: Request) => Promise<Response>>()
        .mockResolvedValueOnce(
            new Response(JSON.stringify({ error: `unauthorized` }), { status: 401, headers: { "content-type": `application/json` } }),
        )
        .mockResolvedValueOnce(eventStream([{ kind: `heartbeat` }]));
    stubGlobal(`fetch`, fetchMock);

    await (await sandboxRpc.system.events({ clientId: `c1` }))[Symbol.asyncIterator]().next();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0]?.[0].headers.get(`authorization`)).toBe(`Bearer session-token`);
    expect(fetchMock.mock.calls[1]?.[0].headers.get(`authorization`)).toBe(`Bearer replacement-token`);
    expect(authState.rejected).toEqual([`session-token`]);
});

it(`surfaces the daemon's status so a refusal can be told from a failure to connect`, async () => {
    // Hand-written routes answer `{ error }` with a bare status, not oRPC's envelope, and it must still survive.
    stubGlobal(
        `fetch`,
        jest.fn(
            async () => new Response(JSON.stringify({ error: `not a member` }), { status: 403, headers: { "content-type": `application/json` } }),
        ),
    );
    const failure = await sandboxRpc.system.events({ clientId: `c1` }).catch((error: unknown) => error);
    expect(daemonErrorStatus(failure)).toBe(403);
    expect(daemonErrorMessage(failure)).toBe(`not a member`);
});

// A custom header forces a CORS preflight; a daemon that hasn't advertised REQUEST_ID_HEADER in allowHeaders
// fails the whole request, not just the header, so it's only sent once advertised.
it(`withholds the correlation header from a daemon that has not advertised it`, async () => {
    resetSandboxScope();
    const fetchMock = jest.fn(async (_request: Request) => eventStream([{ kind: `heartbeat` }]));
    stubGlobal(`fetch`, fetchMock);
    await (await sandboxRpc.system.events({ clientId: `c1` }))[Symbol.asyncIterator]().next();
    expect(fetchMock.mock.calls[0]![0].headers.get(REQUEST_ID_HEADER)).toBeNull();

    // An older daemon that advertises other routes but not this one is still evidence of the wrong thing.
    setDaemonRoutes([`system.info`, `system.events`]);
    await (await sandboxRpc.system.events({ clientId: `c2` }))[Symbol.asyncIterator]().next();
    expect(fetchMock.mock.calls[1]![0].headers.get(REQUEST_ID_HEADER)).toBeNull();
    resetSandboxScope();
});

it(`sends the correlation header once the daemon advertises the route that ships with it`, async () => {
    setDaemonRoutes([`system.events`, REQUEST_ID_EVIDENCE_ROUTE]);
    const fetchMock = jest.fn(async (_request: Request) => eventStream([{ kind: `heartbeat` }]));
    stubGlobal(`fetch`, fetchMock);
    await (await sandboxRpc.system.events({ clientId: `c1` }))[Symbol.asyncIterator]().next();
    const sent = fetchMock.mock.calls[0]![0].headers.get(REQUEST_ID_HEADER);
    // The join key the daemon echoes back; only that it's present and distinct per call matters, not its shape.
    expect(sent).toEqual(expect.stringMatching(/\S/));
    await (await sandboxRpc.system.events({ clientId: `c2` }))[Symbol.asyncIterator]().next();
    expect(fetchMock.mock.calls[1]![0].headers.get(REQUEST_ID_HEADER)).not.toBe(sent);
    resetSandboxScope();
});

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": `application/json` } });

it(`hands an answer back as its output schema reads it, defaults filled in`, async () => {
    stubGlobal(
        `fetch`,
        jest.fn(async () => json(200, {})),
    );
    expect(await sandboxRpc.settings.get()).toEqual(SandboxSettingsSchema.parse({}));
});

it(`refuses an answer its output schema cannot read, as the version drift it is`, async () => {
    stubGlobal(
        `fetch`,
        jest.fn(async () => json(200, { skills: `not a list` })),
    );
    const failure = await sandboxRpc.settings.get().catch((error: unknown) => error);
    expect(readFailure(failure)).toStartWith(`This sandbox answered in a shape this app doesn't expect.`);
});

it(`reads a refusal in the daemon's own words, carrying its status`, async () => {
    stubGlobal(
        `fetch`,
        jest.fn(async () => json(409, { message: `This agent is running a turn.` })),
    );
    const failure = await sandboxRpc.settings.get().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxHttpError);
    expect(failure).toMatchObject({ status: 409, message: `This agent is running a turn.` });
});

// An extension calls through its own gated client (extension-host/apiImpl.ts), and reads what comes back as the app does.
it(`gives an extension's gated client the app's reading of an answer and a refusal`, async () => {
    stubGlobal(
        `fetch`,
        jest
            .fn<(request: Request) => Promise<Response>>()
            .mockResolvedValueOnce(json(200, {}))
            .mockResolvedValueOnce(json(409, { message: `This agent is running a turn.` })),
    );
    const gated = gatedSandboxRpc(() => undefined);
    expect(await gated.settings.get()).toEqual(SandboxSettingsSchema.parse({}));
    const failure = await gated.settings.get().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SandboxHttpError);
    expect(failure).toMatchObject({ status: 409, message: `This agent is running a turn.` });
});

it(`refuses an extension's undeclared call at its gate, before anything is sent`, async () => {
    const fetchMock = jest.fn(async () => json(200, {}));
    stubGlobal(`fetch`, fetchMock);
    const gated = gatedSandboxRpc((procedure) => {
        throw new Error(`${procedure.join(`.`)} is not declared`);
    });
    expect(await gated.settings.get().catch((error: unknown) => (error as Error).message)).toBe(`settings.get is not declared`);
    expect(fetchMock.mock.calls).toEqual([]);
});

it(`reads a hand-written route's { error } the same way, and a wordless refusal by its status`, async () => {
    stubGlobal(
        `fetch`,
        jest
            .fn<(request: Request) => Promise<Response>>()
            .mockResolvedValueOnce(json(403, { error: `not a member` }))
            .mockResolvedValueOnce(new Response(`<html>bad gateway</html>`, { status: 502, headers: { "content-type": `text/html` } })),
    );
    expect(await sandboxRpc.settings.get().catch((error: unknown) => error)).toMatchObject({ status: 403, message: `not a member` });
    expect(await sandboxRpc.settings.get().catch((error: unknown) => error)).toMatchObject({ status: 502, message: `Request failed (502).` });
});

it(`blames the sandbox's image for a 404 on a route its daemon never advertised`, async () => {
    setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => name !== `vpn.list`));
    stubGlobal(
        `fetch`,
        jest.fn(async () => json(404, { message: `Not Found` })),
    );
    const failure = await sandboxRpc.vpn.list().catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 404 });
    expect((failure as Error).message).toStartWith(`This sandbox's daemon doesn't provide 'vpn.list'.`);
    resetSandboxScope();
});

it(`blames the drift for a 400 on a route whose shape the daemon disagrees about`, async () => {
    setDaemonRoutes([...SANDBOX_ROUTE_NAMES], { ...SANDBOX_ROUTE_SHAPES, "settings.set": `different` });
    stubGlobal(
        `fetch`,
        jest.fn(async () => json(400, { message: `Input validation failed` })),
    );
    const failure = await sandboxRpc.settings.set({}).catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 400 });
    expect((failure as Error).message).toStartWith(
        `This sandbox's daemon has 'settings.set' but exchanges different fields for it than this app expects.`,
    );
    resetSandboxScope();
});

it(`aims a call at another sandbox by id, through that box's address and connect token`, async () => {
    const fetchMock = jest.fn(async (_request: Request) => json(200, {}));
    stubGlobal(`fetch`, fetchMock);
    await sandboxRpc.settings.get(undefined, { context: { at: `s2` } });
    const request = fetchMock.mock.calls[0]![0];
    expect(request.url).toBe(`https://other.test/settings`);
    expect(request.headers.get(`x-intentic-connect`)).toBe(`other-connect`);
});

it(`keeps another box's refusal in its own words, since this daemon's routes say nothing about it`, async () => {
    setDaemonRoutes(SANDBOX_ROUTE_NAMES.filter((name) => name !== `vpn.list`));
    stubGlobal(
        `fetch`,
        jest.fn(async () => json(404, { message: `Not Found` })),
    );
    expect(await sandboxRpc.vpn.list(undefined, { context: { at: `s2` } }).catch((error: unknown) => error)).toMatchObject({
        status: 404,
        message: `Not Found`,
    });
    resetSandboxScope();
});

it(`never sends the correlation header to another box, whose support this daemon cannot vouch for`, async () => {
    setDaemonRoutes([`settings.get`, REQUEST_ID_EVIDENCE_ROUTE]);
    const fetchMock = jest.fn(async (_request: Request) => json(200, {}));
    stubGlobal(`fetch`, fetchMock);
    await sandboxRpc.settings.get(undefined, { context: { at: `s2` } });
    expect(fetchMock.mock.calls[0]![0].headers.get(REQUEST_ID_HEADER)).toBeNull();
    resetSandboxScope();
});

it(`asks for a credential quietly on a background call, and fails like an unreachable box without one`, async () => {
    authState.token = `session-token`;
    authState.asked = [];
    stubGlobal(
        `fetch`,
        jest.fn(async () => json(200, {})),
    );
    await sandboxRpc.settings.get(undefined, { context: { at: `s2`, background: true } });
    await sandboxRpc.settings.get();
    expect(authState.asked).toEqual([
        { base: `https://other.test`, background: true },
        { base: `https://daemon.test`, background: false },
    ]);
    authState.token = undefined;
    await expect(sandboxRpc.settings.get(undefined, { context: { at: `s2`, background: true } })).rejects.toThrow(
        `This browser holds no session for that sandbox yet.`,
    );
    authState.token = `session-token`;
});

it(`lifts the headers deadline only for a call that says its answer takes as long as its work`, async () => {
    stubGlobal(
        `fetch`,
        jest.fn(async () => json(200, {})),
    );
    const timeout = jest.spyOn(AbortSignal, `timeout`);
    await sandboxRpc.settings.get(undefined, { context: { deadline: false } });
    expect(timeout).not.toHaveBeenCalled();
    await sandboxRpc.settings.get();
    expect(timeout).toHaveBeenCalledWith(45_000);
    timeout.mockRestore();
});

// A path parameter is one segment whatever it holds, so a crafted id cannot reach another route.
it(`encodes a path parameter into its own segment`, async () => {
    const fetchMock = jest.fn(async (_request: Request) => json(200, { ok: true }));
    stubGlobal(`fetch`, fetchMock);
    await sandboxRpc.panels.start({ repo: `../../etc` });
    expect(new URL(fetchMock.mock.calls[0]![0].url).pathname).toBe(`/panels/..%2F..%2Fetc/start`);
});

// A newer daemon than this page is ordinary; a frame of a kind this build has no name for must not end the stream.
it(`hands a streamed frame on unparsed, including a kind this build does not know`, async () => {
    stubGlobal(
        `fetch`,
        jest.fn(async () => eventStream([{ kind: `somethingLater`, detail: 1 }, { kind: `heartbeat` }])),
    );
    const received: unknown[] = [];
    for await (const frame of await sandboxRpc.system.events({ clientId: `c1` })) {
        received.push(frame);
    }
    expect(received).toEqual([{ kind: `somethingLater`, detail: 1 }, { kind: `heartbeat` }]);
});

// Last, since it leaves the sandbox unaddressed for good.
it(`names an unaddressed sandbox as its own condition, before any request goes out`, async () => {
    sandbox.active.value = undefined;
    sandbox.activeSandboxId.value = undefined;
    sandbox.daemonUrl.value = undefined;
    const fetchMock = jest.fn();
    stubGlobal(`fetch`, fetchMock);
    await expect(sandboxRpc.system.info()).rejects.toBeInstanceOf(SandboxUnaddressedError);
    expect(fetchMock).not.toHaveBeenCalled();
});
