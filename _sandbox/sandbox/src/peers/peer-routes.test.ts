import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { z } from "zod";
import { createTurnMounts } from "../agent/tools/turn-mounts.js";
import { createTurnMountRoute, type MountEndpoints } from "../agent/tools/turn-mounts.routes.js";
import type { Services } from "../composition.js";
import type { PeerDoor } from "./peer.js";
import type { PeerHub } from "./peer-hub.js";
import { admitPeer, createPeerRoutes, greetPeer } from "./peer-routes.js";
import { type Presented, webextEnrollmentsDocument, webextPairConsumedDocument } from "./enrollment.js";
import type { PeerStore } from "./peer-store.js";

// A door's two documents on /history: a browser's, whose records carry nothing beside the digest.
const BROWSER_DOCUMENTS = { enrollments: webextEnrollmentsDocument, consumed: webextPairConsumedDocument };

// A peer's MCP bridge, reached the way a turn reaches it: mounted on a turn's lease and served by the daemon's one MCP
// door on a bare Hono. Pins the bridge's decisions (what an unknown or offline peer looks like, verbatim forwarding)
// plus its two hooks (judgement before a call, seal on the answer).

const door: PeerDoor<{ type: "hello"; token: string; version: string }, { version: string }, Record<never, never>> = {
    slug: "hosts",
    noun: "device",
    listKey: "hosts",
    store: { documents: BROWSER_DOCUMENTS, key: "browsers", prefix: "iht_", extra: {} },
    hub: { domain: "hosts", heartbeatMs: 30_000, callTimeoutMs: 60_000, offline: (id) => `"${id}" is not connected right now` },
    hello: {
        schema: z.object({ type: z.literal("hello"), token: z.string(), version: z.string() }),
        announced: (hello) => ({ version: hello.version }),
    },
    scopesKind: "device",
    mcp: { serverName: (id) => `intentic-machine:${id}` },
    expired: "pairing expired",
};

type Hub = PeerHub<never, { version: string }, unknown, unknown>;

const routeFor = (
    overrides: {
        mcp?: (id: string, payload: unknown) => Promise<unknown>;
        enrolled?: boolean;
        online?: boolean;
        knownTools?: unknown;
        beforeCall?: (payload: unknown, call: { readonly id: string; readonly conversationId: string | undefined }) => Promise<{ refusal: string } | undefined>;
        sealAnswer?: (id: string, tool: string, answer: unknown) => unknown;
    } = {},
) => {
    const remembered: unknown[] = [];
    const hub = {
        mcp: overrides.mcp ?? (async () => ({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
        online: () => overrides.online ?? true,
        state: () => ({ online: overrides.online ?? true, announced: { version: "0.1.0" } }),
        knownTools: () => overrides.knownTools,
        rememberTools: (_id: string, result: unknown) => void remembered.push(result),
    } as unknown as Hub;
    const store = { enrolled: async () => overrides.enrolled ?? true } as unknown as PeerStore<Record<never, never>>;
    const routes = createPeerRoutes({ logger: { warn: () => {} } } as unknown as Services, door, {
        store,
        hub,
        summaries: async () => [],
        ...(overrides.beforeCall === undefined ? {} : { beforeCall: overrides.beforeCall }),
        ...(overrides.sealAnswer === undefined ? {} : { sealAnswer: overrides.sealAnswer }),
    });
    const mounts = createTurnMounts({ baseUrl: () => "http://127.0.0.1:1/mcp" });
    const { token } = mounts.lease("conv-1").open({ name: "laptop", target: { kind: "device", id: "laptop" } });
    const app = new Hono().all("/mcp/:mount", createTurnMountRoute(mounts, unstubbed<MountEndpoints>("endpoints", { device: routes.mcp })));
    return Object.assign(app, { remembered, token: token ?? "" });
};

const post = async (app: Hono & { token: string }, body: unknown, token = app.token): Promise<Response> =>
    app.request("/mcp/laptop", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });

test("a request without a live mount bearer is refused", async () => {
    expect((await post(routeFor(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status).toBe(401);
});

test("a peer that was never enrolled is a readable error naming the door's noun, not a hanging call", async () => {
    const response = await post(routeFor({ enrolled: false }), { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 1, error: { code: -32000, message: `no connected device named "laptop"` } });
});

test("a request is forwarded verbatim and its answer returned unchanged", async () => {
    const mcp = jest.fn(async () => ({ jsonrpc: "2.0", id: 9, result: { tools: [{ name: "run_command" }] } }));
    const response = await post(routeFor({ mcp }), { jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(mcp).toHaveBeenCalledWith("laptop", { jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 9, result: { tools: [{ name: "run_command" }] } });
});

// A notification has nothing to answer; replying is a protocol violation the MCP client reports as noise.
test("a notification is delivered and answered 202 with no body", async () => {
    const mcp = jest.fn(async () => undefined);
    const response = await post(routeFor({ mcp }), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(mcp).toHaveBeenCalledTimes(1);
});

test("an offline peer answers as a readable JSON-RPC error, not an HTTP failure", async () => {
    const app = routeFor({
        mcp: async () => {
            throw new Error(`"laptop" is not connected right now`);
        },
    });
    const response = await post(app, { jsonrpc: "2.0", id: 4, method: "tools/call" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 4, error: { code: -32000, message: `"laptop" is not connected right now` } });
});

test("an asleep peer still completes the handshake under the door's server name and its last build", async () => {
    const mcp = jest.fn();
    const response = await post(routeFor({ online: false, mcp }), { jsonrpc: "2.0", id: 1, method: "initialize" });
    const body = (await response.json()) as { result: { capabilities: Record<string, unknown>; serverInfo: { name: string; version: string } } };
    expect(body.result.capabilities).toHaveProperty("tools");
    expect(body.result.serverInfo).toEqual({ name: "intentic-machine:laptop", version: "0.1.0" });
    expect(mcp).not.toHaveBeenCalled();
});

test("an asleep peer lists the tools it last reported, and one that never connected lists nothing", async () => {
    const tools = { tools: [{ name: "run_command" }] };
    expect(await (await post(routeFor({ online: false, knownTools: tools }), { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: tools,
    });
    expect(await (await post(routeFor({ online: false }), { jsonrpc: "2.0", id: 2, method: "tools/list" })).json()).toEqual({
        jsonrpc: "2.0",
        id: 2,
        result: { tools: [] },
    });
});

test("a live tools/list is remembered, which is what makes the offline answer possible", async () => {
    const app = routeFor({ mcp: async () => ({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "screenshot" }] } }) });
    await post(app, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(app.remembered).toEqual([{ tools: [{ name: "screenshot" }] }]);
});

test("a tuple a peer publishes as a boolean-closed array is repaired on the way to the model, and stays repaired offline", async () => {
    const published = {
        tools: [
            {
                name: "device",
                inputSchema: {
                    type: "object",
                    properties: { at: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], items: false } },
                },
            },
        ],
    };
    const app = routeFor({ mcp: async () => ({ jsonrpc: "2.0", id: 3, result: published }) });
    const answered = (await (await post(app, { jsonrpc: "2.0", id: 3, method: "tools/list" })).json()) as { result: unknown };
    const repaired = {
        tools: [
            {
                name: "device",
                inputSchema: {
                    type: "object",
                    properties: { at: { type: "array", prefixItems: [{ type: "number" }, { type: "number" }], maxItems: 2 } },
                },
            },
        ],
    };
    expect(answered.result).toEqual(repaired);
    expect(app.remembered).toEqual([repaired]);
});

test("a tool call on an asleep peer is not answered locally", async () => {
    const mcp = jest.fn(async () => {
        throw new Error("is not connected right now");
    });
    await post(routeFor({ online: false, mcp }), { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "describe" } });
    expect(mcp).toHaveBeenCalledTimes(1);
});

test("a call the door's judgement stops is answered as a refusing tool result and never forwarded", async () => {
    const mcp = jest.fn();
    const app = routeFor({
        mcp,
        beforeCall: async (payload) => ((payload as { id?: number }).id === 7 ? { refusal: "Held for the owner." } : undefined),
    });
    const response = await post(app, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "run_command" } });
    expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: 7,
        result: { content: [{ type: "text", text: "Held for the owner." }], isError: true },
    });
    expect(mcp).not.toHaveBeenCalled();
});

// Not applied to a tool list: that's the peer's own account of itself, not something to wrap.
test("a tool call's answer goes through the door's seal, under the tool's name; a tool list does not", async () => {
    const sealAnswer = jest.fn((id: string, tool: string, answer: unknown) => ({ sealed: `${id}:${tool}`, answer }));
    const app = routeFor({ mcp: async () => ({ jsonrpc: "2.0", id: 1, result: { content: [] } }), sealAnswer });
    const call = await post(app, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "snapshot" } });
    expect(await call.json()).toEqual({ sealed: "laptop:snapshot", answer: { jsonrpc: "2.0", id: 1, result: { content: [] } } });
    await post(app, { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(sealAnswer).toHaveBeenCalledTimes(1);
});

test("the optional server→client stream is refused honestly rather than left open", async () => {
    const app = routeFor();
    const response = await app.request("/mcp/laptop", { method: "GET", headers: { authorization: `Bearer ${app.token}` } });
    expect(response.status).toBe(405);
});

test("a session teardown is accepted", async () => {
    const app = routeFor();
    const response = await app.request("/mcp/laptop", { method: "DELETE", headers: { authorization: `Bearer ${app.token}` } });
    expect(response.status).toBe(204);
});

test("a door without a bridge answers every message with that, and reaches for no peer", async () => {
    const { mcp: _bridge, ...silent } = door;
    const routes = createPeerRoutes({ logger: { warn: () => {} } } as unknown as Services, silent, {
        store: {} as PeerStore<Record<never, never>>,
        hub: {} as Hub,
        summaries: async () => [],
    });
    const call = { name: "laptop", conversationId: undefined, signal: new AbortController().signal };
    expect(await routes.mcp({ id: "laptop" }, { jsonrpc: "2.0", id: 1, method: "tools/list" }, call)).toEqual({
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "a device has no MCP bridge" },
    });
});

// The conversation comes from the bearer's lease, never from the request: it is what the host command gate judges in.
test("the door's judgement is told which machine and which conversation a call came from", async () => {
    const beforeCall = jest.fn(async () => undefined);
    await post(routeFor({ beforeCall }), { jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "run_command" } });
    expect(beforeCall).toHaveBeenCalledWith({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "run_command" } }, { id: "laptop", conversationId: "conv-1" });
});

// The hello frame resolves which peer is knocking; the card decides whether anything still grants it a machine, and its
// config IS the grant pushed over the socket.
const laptopCard = { id: "laptop", kind: "device", config: { platform: "linux", shell: "on" } };

const admission = async (presented: Presented, cards: readonly (typeof laptopCard)[]) =>
    admitPeer<{ platform: string }>(
        { capabilities: { list: async () => cards } } as unknown as Services,
        door,
        { verify: async () => presented },
        "presented-token",
    );

const enrolled = (id: string, card = id): Presented => ({ kind: "enrolled", id, card });

test("an enrolled peer whose card still grants it attaches with that card's config as its scopes", async () => {
    expect(await admission(enrolled("laptop"), [laptopCard])).toEqual({ id: "laptop", scopes: laptopCard.config });
});

// `retry: false` is the expensive verdict: it closes 1008, which ends the far end's dial loop for good. Only a store
// this daemon could read and that holds no such token earns it.
test("a token the store read and does not hold is the one refusal that is final", async () => {
    expect(await admission({ kind: "unknown" }, [laptopCard])).toEqual({ refusal: "unauthorized", retry: false });
});

// A manifest this build could not parse answers `verify` with the same empty list an empty one does. Reporting that as
// "not enrolled" is what used to unpair every connected machine over one unreadable file.
test("an enrollment manifest that could not be read refuses without spending the pairing", async () => {
    const refused = await admission({ kind: "unreadable", detail: "the file is not valid JSON" }, [laptopCard]);
    expect(refused).toMatchObject({ retry: true });
    expect("refusal" in refused && refused.refusal).toContain("not valid JSON");
});

// The state this exists for: a card removed while the enrollment survived (a hand-edited manifest, a landed checkout,
// a recreate whose /work is still settling). Attaching would run on scopes nobody is granting any more — but the card
// lives in the workspace and the enrollment does not, so its absence is drift, not a withdrawal. peers/invariant.ts
// reports it and dropping the enrollment is what makes it final.
test("an enrollment no card holds is refused, and invited back rather than unpaired", async () => {
    expect(await admission(enrolled("ghost"), [laptopCard])).toEqual({
        refusal: `no capability card grants this device anything right now`,
        retry: true,
    });
});

// The greeting runs inside a socket handler whose promise nobody awaits, so a rejection there is unhandled.
const greeting = (overrides: { pushed?: () => Promise<boolean>; describe?: () => Promise<unknown> } = {}) => {
    const order: string[] = [];
    const warned: Record<string, unknown>[] = [];
    const hub = {
        pushScopes: jest.fn(async () => {
            order.push("pushScopes");
            return (await overrides.pushed?.()) ?? true;
        }),
        observe: jest.fn(() => void order.push("observe")),
    };
    const client = {
        describe: jest.fn(async () => {
            order.push("describe");
            return (await overrides.describe?.()) ?? { os: "linux" };
        }),
        ping: async () => ({}),
    };
    const hangUp = jest.fn();
    const onConnected = jest.fn();
    const greeted = greetPeer({ logger: { warn: (data: Record<string, unknown>) => void warned.push(data) } } as unknown as Services, "hosts", hub, {
        id: "laptop",
        client,
        scopes: { shell: "on" },
        hangUp,
        onConnected,
    });
    return { greeted, order, warned, hangUp, onConnected, client };
};

test("a greeted peer gets its grant before it is asked what it is", async () => {
    const run = greeting();
    await run.greeted;
    expect(run.order).toEqual(["pushScopes", "describe", "observe"]);
    expect(run.onConnected).toHaveBeenCalledWith("laptop", { os: "linux" });
    expect(run.hangUp).not.toHaveBeenCalled();
});

test("a socket that closes between hello and describe is logged and hung up, never an unhandled rejection", async () => {
    const run = greeting({
        describe: async () => {
            throw new Error("Cannot send message, WebSocket is not open.");
        },
    });
    await expect(run.greeted).resolves.toBeUndefined();
    expect(run.warned).toEqual([expect.objectContaining({ id: "laptop" })]);
    expect(run.hangUp).toHaveBeenCalledTimes(1);
    expect(run.onConnected).not.toHaveBeenCalled();
});

// The hub already dropped the socket its push failed on; asking that socket anything else only fails again.
test("a grant the hub could not deliver ends the greeting without asking the peer anything", async () => {
    const run = greeting({ pushed: async () => false });
    await run.greeted;
    expect(run.client.describe).not.toHaveBeenCalled();
    expect(run.hangUp).not.toHaveBeenCalled();
    expect(run.onConnected).not.toHaveBeenCalled();
});
