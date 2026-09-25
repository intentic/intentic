import { type Capability, rawRoutePath } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { tokenEquals } from "../../auth/auth.js";
import type { Services } from "../../composition.js";
import { createBrowserMcpRoute, createBrowserRouters, prepareKnownOwner } from "./browser-prepare.js";
import { createBrowserRouterHub } from "./browser-router.js";

// The daemon's side of a turn's browser routers: which owners a router may have built, and the door its MCP client
// reaches it through. What a prepare actually builds is browser-tools.integration.test.ts's business; how a router
// routes is browser-router.integration.test.ts's.

const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };
const ROUTE = rawRoutePath("POST /mcp/browser/{id}");

const servicesHolding = (capabilities: readonly Capability[] = [reddit]) =>
    unstubbed<Pick<Services, "capabilities" | "workspace">>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root: "/nonexistent-workspace" }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [...capabilities] }),
    });

test("an owner this sandbox does not hold is refused by name, not built", async () => {
    expect(await prepareKnownOwner(servicesHolding(), "../../etc", 41_000)).toEqual({
        refusal: 'no browser profile named "../../etc" in this sandbox',
    });
});

// A capability was granted, so the answer is about the browser (absent on a CI image), never about the name.
test("an owner this sandbox does hold gets past the name check", async () => {
    const answer = (await prepareKnownOwner(servicesHolding(), "reddit", 41_000)) as { refusal?: string };
    expect(answer.refusal ?? "").not.toContain("no browser profile named");
});

test("a router is reached at this daemon's own loopback door", () => {
    const hub = createBrowserRouters(() => ({
        ...servicesHolding(),
        config: unstubbed<Services["config"]>("config", { sandbox: { port: 4242 } as Services["config"]["sandbox"] }),
    }));
    const { id, url } = hub.open({ accounts: {}, owners: {}, backendEnv: {} });
    expect(url).toBe(`http://127.0.0.1:4242/mcp/browser/${id}`);
    hub.closeAll();
});

const routed = () => {
    const hub = createBrowserRouterHub({
        baseUrl: () => "http://127.0.0.1:1/mcp/browser",
        router: {
            toolSchemas: async () => [{ name: "browser_probe", inputSchema: { type: "object", properties: {} } } as never],
            prepare: async () => ({ refusal: "not in this test" }),
        },
        tokenEquals,
    });
    const app = new Hono();
    const route = createBrowserMcpRoute({ browserRouters: hub });
    app.post(ROUTE.replace("{id}", ":id"), route);
    app.get(ROUTE.replace("{id}", ":id"), route);
    app.delete(ROUTE.replace("{id}", ":id"), route);
    return { hub, app };
};

const post = (app: Hono, id: string, token: string, body: unknown): Promise<Response> =>
    Promise.resolve(
        app.request(`/mcp/browser/${id}`, {
            method: "POST",
            headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
            body: JSON.stringify(body),
        }),
    );

test("a router answers its own bearer as JSON, and a notification with 202", async () => {
    const { hub, app } = routed();
    const { id, token } = hub.open({ accounts: {}, owners: {}, backendEnv: {} });
    const listed = await post(app, id, token, { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });
    expect(listed.status).toBe(200);
    expect(((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name)).toEqual(["browser_probe"]);
    expect((await post(app, id, token, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
});

test("a wrong bearer, another router's bearer and an ended turn all look alike: no such router", async () => {
    const { hub, app } = routed();
    const first = hub.open({ accounts: {}, owners: {}, backendEnv: {} });
    const second = hub.open({ accounts: {}, owners: {}, backendEnv: {} });
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(app, first.id, "wrong", ping)).status).toBe(404);
    expect((await post(app, first.id, second.token, ping)).status).toBe(404);
    hub.close(first.id);
    expect((await post(app, first.id, first.token, ping)).status).toBe(404);
    expect((await post(app, second.id, second.token, ping)).status).toBe(200);
});

test("there is no server-initiated stream to open, and a client hanging up leaves the router standing", async () => {
    const { hub, app } = routed();
    const { id, token } = hub.open({ accounts: {}, owners: {}, backendEnv: {} });
    const headers = { authorization: `Bearer ${token}` };
    expect((await app.request(`/mcp/browser/${id}`, { method: "GET", headers })).status).toBe(405);
    expect((await app.request(`/mcp/browser/${id}`, { method: "DELETE", headers })).status).toBe(204);
    expect((await post(app, id, token, { jsonrpc: "2.0", id: 2, method: "ping" })).status).toBe(200);
});
