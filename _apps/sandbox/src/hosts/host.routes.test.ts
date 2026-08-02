import { Hono } from "hono";
import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { createHostMcpRoute } from "./host.routes.js";

/* The agent's door onto a connected computer. Mounted on a bare Hono rather than the whole daemon: the route
 * touches exactly three services, and what is worth pinning here is its DECISIONS — who may knock, what an
 * offline machine looks like to a model, and that the daemon forwards without interpreting. */

const BRIDGE = "bridge-token";

const routeFor = (
    overrides: {
        mcp?: (id: string, payload: unknown) => Promise<unknown>;
        enrolled?: boolean;
        online?: boolean;
        knownTools?: unknown;
    } = {},
) => {
    const remembered: unknown[] = [];
    const services = {
        hostBridgeToken: BRIDGE,
        hosts: { enrolled: async () => overrides.enrolled ?? true },
        hostHub: {
            mcp: overrides.mcp ?? (async () => ({ jsonrpc: "2.0", id: 1, result: { ok: true } })),
            online: () => overrides.online ?? true,
            state: () => ({ online: overrides.online ?? true, version: "0.1.0" }),
            knownTools: () => overrides.knownTools,
            rememberTools: (_id: string, result: unknown) => void remembered.push(result),
        },
    } as unknown as Services;
    return Object.assign(new Hono().all("/mcp/hosts/:id", createHostMcpRoute(services)), { remembered });
};

const post = async (app: Hono, body: unknown, token = BRIDGE): Promise<Response> =>
    app.request("/mcp/hosts/laptop", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });

test("a request without the bridge token is refused", async () => {
    expect((await post(routeFor(), { jsonrpc: "2.0", id: 1, method: "tools/list" }, "wrong")).status).toBe(401);
});

test("a machine that was never enrolled is a 404, not a hanging call", async () => {
    expect((await post(routeFor({ enrolled: false }), { jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
});

test("a request is forwarded verbatim and its answer returned unchanged", async () => {
    const mcp = vi.fn(async () => ({ jsonrpc: "2.0", id: 9, result: { tools: [{ name: "run_command" }] } }));
    const response = await post(routeFor({ mcp }), { jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(mcp).toHaveBeenCalledWith("laptop", { jsonrpc: "2.0", id: 9, method: "tools/list" });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 9, result: { tools: [{ name: "run_command" }] } });
});

// A notification has nothing to answer; replying to one is a protocol violation the MCP client reports as noise.
test("a notification is delivered and answered 202 with no body", async () => {
    const mcp = vi.fn(async () => undefined);
    const response = await post(routeFor({ mcp }), { jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(mcp).toHaveBeenCalled();
});

/* The behaviour this route exists to get right: laptops sleep, and a sleeping laptop is a normal state. As a
 * JSON-RPC error the model reads "this computer is asleep" and says so; as an HTTP 503 it surfaces as a broken
 * MCP transport and invites a retry loop. */
test("an offline machine answers as a readable JSON-RPC error, not an HTTP failure", async () => {
    const app = routeFor({
        mcp: async () => {
            throw new Error(`"laptop" is not connected right now — the computer is asleep, offline, or its agent isn't running.`);
        },
    });
    const response = await post(app, { jsonrpc: "2.0", id: 4, method: "tools/call" });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
        jsonrpc: "2.0",
        id: 4,
        error: { code: -32000, message: `"laptop" is not connected right now — the computer is asleep, offline, or its agent isn't running.` },
    });
});

/* A turn loads its MCP servers up front, and personal computers are asleep half the time. If the handshake went
 * to the machine, an asleep laptop would drop out of the turn entirely — the agent would not know it exists. */
test("an asleep machine still completes the handshake, so it stays in the turn", async () => {
    const mcp = vi.fn();
    const response = await post(routeFor({ online: false, mcp }), { jsonrpc: "2.0", id: 1, method: "initialize" });
    const body = (await response.json()) as { result: { capabilities: Record<string, unknown> } };
    expect(body.result.capabilities).toHaveProperty("tools");
    expect(mcp).not.toHaveBeenCalled();
});

test("an asleep machine lists the tools it last reported", async () => {
    const tools = { tools: [{ name: "run_command" }] };
    const response = await post(routeFor({ online: false, knownTools: tools }), { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 2, result: tools });
});

test("a machine that has never connected lists nothing rather than failing", async () => {
    const response = await post(routeFor({ online: false }), { jsonrpc: "2.0", id: 2, method: "tools/list" });
    expect(await response.json()).toEqual({ jsonrpc: "2.0", id: 2, result: { tools: [] } });
});

test("a live tools/list is remembered, which is what makes the offline answer possible", async () => {
    const app = routeFor({ mcp: async () => ({ jsonrpc: "2.0", id: 3, result: { tools: [{ name: "screenshot" }] } }) });
    await post(app, { jsonrpc: "2.0", id: 3, method: "tools/list" });
    expect(app.remembered).toEqual([{ tools: [{ name: "screenshot" }] }]);
});

// Calling a tool is about the COMPUTER, not the connection — it goes to the machine and comes back as the
// readable "asleep" answer, never a locally invented result.
test("a tool call on an asleep machine is not answered locally", async () => {
    const mcp = vi.fn(async () => {
        throw new Error("is not connected right now");
    });
    await post(routeFor({ online: false, mcp }), { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "describe" } });
    expect(mcp).toHaveBeenCalled();
});

test("the optional server→client stream is refused honestly rather than left open", async () => {
    const response = await routeFor().request("/mcp/hosts/laptop", { method: "GET", headers: { authorization: `Bearer ${BRIDGE}` } });
    expect(response.status).toBe(405);
});

test("a session teardown is accepted", async () => {
    const response = await routeFor().request("/mcp/hosts/laptop", { method: "DELETE", headers: { authorization: `Bearer ${BRIDGE}` } });
    expect(response.status).toBe(204);
});
