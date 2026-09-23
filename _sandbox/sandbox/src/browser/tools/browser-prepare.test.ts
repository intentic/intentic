import { type Capability, rawRoutePath } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { test, expect } from "bun:test";
import type { Services } from "../../composition.js";
import { browserPrepareBridge, createBrowserPrepareRoute } from "./browser-prepare.js";

// The door a turn's browser router knocks on to have one profile built. What is pinned here is who may knock and for
// what; what a knock actually builds is browser-tools.integration.test.ts's business.

const TOKEN = "bridge-secret";
const PREPARE = rawRoutePath("POST /system/browser/prepare");
const reddit: Capability = { id: "reddit", kind: "browser", config: { platform: "reddit" } };

const routeFor = (capabilities: readonly Capability[] = [reddit]) => {
    const services = unstubbed<Services>("services", {
        browserBridgeToken: TOKEN,
        workspace: unstubbed<Services["workspace"]>("workspace", { root: "/nonexistent-workspace" }),
        capabilities: unstubbed<Services["capabilities"]>("capabilities", { list: async () => [...capabilities] }),
    });
    return new Hono().post(PREPARE, createBrowserPrepareRoute(services));
};

const knock = async (app: Hono, body: unknown, token: string = TOKEN): Promise<Response> =>
    app.request(PREPARE, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(body),
    });

test("the bridge points a router at this daemon's own loopback door", () => {
    const bridge = browserPrepareBridge(
        unstubbed<Pick<Services, "config" | "browserBridgeToken">>("services", {
            browserBridgeToken: TOKEN,
            config: unstubbed<Services["config"]>("config", { sandbox: { port: 4242 } as Services["config"]["sandbox"] }),
        }),
    );
    expect(bridge).toEqual({ url: "http://127.0.0.1:4242/system/browser/prepare", token: TOKEN });
});

test("a knock without the bridge token is refused before any profile is looked up", async () => {
    const response = await knock(routeFor(), { owner: "reddit", port: 41_000 }, "wrong-token");
    expect(response.status).toBe(401);
});

test("a knock naming no port is refused: the spec it would build has to be pinned to one", async () => {
    const response = await knock(routeFor(), { owner: "reddit" });
    expect(response.status).toBe(400);
});

test("an owner this sandbox does not hold is refused by name, not built", async () => {
    const response = await knock(routeFor(), { owner: "../../etc", port: 41_000 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ refusal: 'no browser profile named "../../etc" in this sandbox' });
});

// A capability was granted, so the answer is about the browser (absent on a CI image), never about the name.
test("an owner this sandbox does hold gets past the name check", async () => {
    const response = await knock(routeFor(), { owner: "reddit", port: 41_000 });
    const answer = (await response.json()) as { refusal?: string };
    expect(answer.refusal ?? "").not.toContain("no browser profile named");
});
