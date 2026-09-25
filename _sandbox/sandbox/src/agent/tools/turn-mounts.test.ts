import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { createTurnMounts, type InProcessServer, type RpcMessage } from "./turn-mounts.js";
import { createTurnMountRoute, type MountEndpoints } from "./turn-mounts.routes.js";

// Every daemon-hosted MCP server a turn mounts: one bearer per conversation, a lease per turn naming what it reaches,
// and the one door that holds a request to that lease before any target sees it.

const DAY_MS = 24 * 3_600_000;

// An in-process server that answers by echoing the method it was asked, and records whether it was closed.
const echoServer = (): InProcessServer & { readonly closed: () => number } => {
    let closed = 0;
    return {
        handle: async (message) => (message.id === undefined ? undefined : { jsonrpc: "2.0", id: message.id, result: { echoed: message.method } }),
        close: () => {
            closed += 1;
        },
        closed: () => closed,
    };
};

const mountsAt = (now?: () => number) => createTurnMounts({ baseUrl: () => "http://127.0.0.1:8787/mcp", ...(now === undefined ? {} : { now }) });

test("a conversation keeps one bearer across its turns, and each turn's lease reaches only what that turn mounted", () => {
    const mounts = mountsAt();
    const first = mounts.lease("conv-a");
    const billing = first.open({ name: "billing", target: { kind: "extension", card: "billing" } });
    expect(billing).toEqual({ name: "billing", url: "http://127.0.0.1:8787/mcp/billing", token: billing.token });
    expect(mounts.resolve(billing.token, "billing")).toEqual({ target: { kind: "extension", card: "billing" }, conversationId: "conv-a" });
    expect(mounts.resolve(billing.token, "payroll")).toEqual({ refused: "unleased" });

    first.release();
    // Between turns the bearer is known and reaches nothing.
    expect(mounts.resolve(billing.token, "billing")).toEqual({ refused: "unleased" });

    // The next turn gets the same bearer and the same URL for a server of the same name (an ACP session keeps both),
    // leased that turn's own targets.
    const second = mounts.lease("conv-a");
    const laptop = second.open({ name: "laptop", target: { kind: "device", id: "laptop" } });
    expect(laptop.token).toBe(billing.token);
    expect(mounts.resolve(laptop.token, "laptop")).toEqual({ target: { kind: "device", id: "laptop" }, conversationId: "conv-a" });
    expect(mounts.resolve(laptop.token, "billing")).toEqual({ refused: "unleased" });
    // A stale release of the earlier turn takes nothing from the later one.
    first.release();
    expect(mounts.resolve(laptop.token, "laptop")).toMatchObject({ target: { kind: "device", id: "laptop" } });
});

test("a bearer reaches nothing another conversation mounted, and a forged or absent one is unknown", () => {
    const mounts = mountsAt();
    const a = mounts.lease("conv-a").open({ name: "billing", target: { kind: "extension", card: "billing" } });
    const b = mounts.lease("conv-b").open({ name: "payroll", target: { kind: "extension", card: "payroll" } });
    expect(a.token).not.toBe(b.token);
    expect(mounts.resolve(b.token, "billing")).toEqual({ refused: "unleased" });
    expect(mounts.resolve(a.token, "payroll")).toEqual({ refused: "unleased" });
    expect(mounts.resolve("forged", "billing")).toEqual({ refused: "unknown" });
    expect(mounts.resolve(undefined, "billing")).toEqual({ refused: "unknown" });
    expect(mounts.resolve("", "billing")).toEqual({ refused: "unknown" });
});

test("a turn with no conversation has a bearer of its own, forgotten when it ends; a turn that mounts nothing mints none", () => {
    const mounts = mountsAt();
    const loose = mounts.lease();
    const { token } = loose.open({ name: "billing", target: { kind: "extension", card: "billing" } });
    const other = mounts.lease().open({ name: "billing", target: { kind: "extension", card: "billing" } });
    expect(other.token).not.toBe(token);
    loose.release();
    expect(mounts.resolve(token, "billing")).toEqual({ refused: "unknown" });
    // Nothing mounted: nothing minted, and the release is harmless.
    mounts.lease("conv-empty").release();
});

test("a turn's browser routers close with its lease, once, and a mount after the turn ended is closed at once", () => {
    const mounts = mountsAt();
    const lease = mounts.lease("conv-a");
    const web = echoServer();
    const routed = echoServer();
    lease.open({ name: "web", target: { kind: "browser", router: web } });
    const { token } = lease.open({ name: "browser", target: { kind: "browser", router: routed } });
    lease.release();
    lease.release();
    expect([web.closed(), routed.closed()]).toEqual([1, 1]);
    expect(mounts.resolve(token, "web")).toEqual({ refused: "unleased" });

    const late = echoServer();
    lease.open({ name: "web", target: { kind: "browser", router: late } });
    expect(late.closed()).toBe(1);
    expect(mounts.resolve(token, "web")).toEqual({ refused: "unleased" });
});

test("a lease nobody released is swept a day on, its routers closed; closeAll closes every one and forgets every bearer", () => {
    let clock = 1_000;
    const mounts = mountsAt(() => clock);
    const abandoned = echoServer();
    const { token } = mounts.lease("conv-a").open({ name: "web", target: { kind: "browser", router: abandoned } });
    clock += DAY_MS + 1;
    mounts.lease("conv-b");
    expect(abandoned.closed()).toBe(1);
    // Its conversation's bearer went with it: nothing had used it for a day.
    expect(mounts.resolve(token, "web")).toEqual({ refused: "unknown" });

    const live = echoServer();
    const held = mounts.lease("conv-c").open({ name: "web", target: { kind: "browser", router: live } });
    mounts.closeAll();
    expect(live.closed()).toBe(1);
    expect(mounts.resolve(held.token, "web")).toEqual({ refused: "unknown" });
});

// ---- the door -------------------------------------------------------------------------------------------------------

const doorFor = () => {
    const mounts = mountsAt();
    const extension = jest.fn(async () => new Response("forwarded", { status: 200 }));
    const device = jest.fn(async (_target: { readonly id: string }, message: RpcMessage) => ({ jsonrpc: "2.0" as const, id: message.id ?? null, result: { device: true } }));
    const route = createTurnMountRoute(
        mounts,
        unstubbed<MountEndpoints>("endpoints", {
            browser: (target, message, call) => target.router.handle(message, call.signal),
            device,
            extension,
        }),
    );
    const app = new Hono<AppEnv>().all("/mcp/:mount", route);
    const send = (name: string, token: string | undefined, init: { method?: string; body?: unknown } = {}) =>
        app.request(`/mcp/${name}`, {
            method: init.method ?? "POST",
            headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), "content-type": "application/json" },
            ...(init.body === undefined ? {} : { body: typeof init.body === "string" ? init.body : JSON.stringify(init.body) }),
        });
    return { mounts, send, extension, device };
};

test("the door answers a mounted server's messages as JSON, a notification with 202 and a batch as a batch", async () => {
    const { mounts, send } = doorFor();
    const { token } = mounts.lease("conv-a").open({ name: "web", target: { kind: "browser", router: echoServer() } });
    const listed = await send("web", token, { body: { jsonrpc: "2.0", id: 1, method: "tools/list" } });
    expect({ status: listed.status, body: await listed.json() }).toEqual({ status: 200, body: { jsonrpc: "2.0", id: 1, result: { echoed: "tools/list" } } });
    expect((await send("web", token, { body: { jsonrpc: "2.0", method: "notifications/initialized" } })).status).toBe(202);
    const batch = await send("web", token, {
        body: [
            { jsonrpc: "2.0", id: 2, method: "ping" },
            { jsonrpc: "2.0", method: "notifications/initialized" },
        ],
    });
    expect(await batch.json()).toEqual([{ jsonrpc: "2.0", id: 2, result: { echoed: "ping" } }]);
    const garbled = await send("web", token, { body: "{not json" });
    expect({ status: garbled.status, body: await garbled.json() }).toEqual({
        status: 400,
        body: { jsonrpc: "2.0", id: null, error: { code: -32700, message: "invalid json" } },
    });
});

test("there is no server-initiated stream to open, and a client hanging up leaves the mount standing", async () => {
    const { mounts, send } = doorFor();
    const { token } = mounts.lease("conv-a").open({ name: "web", target: { kind: "browser", router: echoServer() } });
    expect((await send("web", token, { method: "GET" })).status).toBe(405);
    expect((await send("web", token, { method: "DELETE" })).status).toBe(204);
    expect((await send("web", token, { body: { jsonrpc: "2.0", id: 3, method: "ping" } })).status).toBe(200);
});

test("the door hands a peer its message with the conversation the bearer belongs to", async () => {
    const { mounts, send, device } = doorFor();
    const { token } = mounts.lease("conv-a").open({ name: "laptop", target: { kind: "device", id: "laptop" } });
    const answer = await send("laptop", token, { body: { jsonrpc: "2.0", id: 4, method: "tools/call" } });
    expect(await answer.json()).toEqual({ jsonrpc: "2.0", id: 4, result: { device: true } });
    expect(device).toHaveBeenCalledWith(
        { kind: "device", id: "laptop" },
        { jsonrpc: "2.0", id: 4, method: "tools/call" },
        expect.objectContaining({ name: "laptop", conversationId: "conv-a" }),
    );
});

test("a bearer cannot reach another conversation's mount, a card its turn was not granted, or anything once its turn ends", async () => {
    const { mounts, send, extension } = doorFor();
    const turnA = mounts.lease("conv-a");
    const a = turnA.open({ name: "billing", target: { kind: "extension", card: "billing" } });
    const b = mounts.lease("conv-b").open({ name: "payroll", target: { kind: "extension", card: "payroll" } });
    const ping = { body: { jsonrpc: "2.0", id: 1, method: "ping" } };

    expect((await send("billing", "forged", ping)).status).toBe(401);
    expect((await send("billing", undefined, ping)).status).toBe(401);
    // Conversation B's live bearer, naming conversation A's card.
    expect((await send("billing", b.token, ping)).status).toBe(403);
    // Conversation A's own bearer, naming a card its turn was not granted.
    expect((await send("payroll", a.token, ping)).status).toBe(403);
    expect(extension).not.toHaveBeenCalled();

    expect((await send("billing", a.token, ping)).status).toBe(200);
    expect(extension).toHaveBeenCalledTimes(1);
    turnA.release();
    expect((await send("billing", a.token, ping)).status).toBe(403);
    expect(extension).toHaveBeenCalledTimes(1);
});
