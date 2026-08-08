import { expect, test } from "vitest";
import { createApp } from "../app.js";
import { memoryCapabilitiesStore, services } from "../route-testing.js";

/* The connection route — the extension BACKENDS' credential read. Two boundaries, each pinned:
 *   • WHO reaches it: only the daemon's header grants. A signed-in member — the OWNER included — is refused
 *     in-route, because everything a browser renders echoes secrets as hasToken booleans and this is the one
 *     read that answers them verbatim.
 *   • WHAT a grant buys: the extension token verifies against its manifest's permissions.daemon through the
 *     ordinary grants table, so an extension that never declared this route is out-of-scope, not served. */

const KOMODO = {
    id: "prod-komodo",
    kind: "cli" as const,
    config: { provider: "komodo", url: "https://komodo.example.com", apiKey: "K-KEY", apiSecret: "K-SECRET" },
};

// Auth ENABLED (the grants middleware only exists on the exposed daemon) with an extension backend holding
// one minted token whose declared reach is exactly this route.
const appWith = (permissions: readonly string[]) =>
    createApp(
        services({
            capabilities: memoryCapabilitiesStore([KOMODO]),
            auth: { authorize: async () => ({ email: "owner@example.com", role: "owner" as const }) },
            extensionBackend: {
                start: async () => {},
                restart: () => {},
                stop: () => {},
                status: () => ({ state: "stopped", extensions: [] }),
                statusOf: () => undefined,
                proxyTarget: () => undefined,
                verifyExtensionToken: (presented) => (presented === "ext-tok" ? { permissions } : undefined),
            },
        }),
    );

test("an extension token with the declared route reads the connection verbatim, secrets included", async () => {
    const app = appWith(["GET /capabilities/*/connection"]);
    const response = await app.request("http://sandbox.test/capabilities/prod-komodo/connection", {
        headers: { "x-intentic-extension": "ext-tok" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ id: "prod-komodo", kind: "cli", config: KOMODO.config });
});

test("the same token without the declaration is out-of-scope, and a wrong token is unauthorized", async () => {
    const app = appWith(["GET /workspace/file"]);
    const undeclared = await app.request("http://sandbox.test/capabilities/prod-komodo/connection", {
        headers: { "x-intentic-extension": "ext-tok" },
    });
    expect(undeclared.status).toBe(403);
    const intruder = await app.request("http://sandbox.test/capabilities/prod-komodo/connection", {
        headers: { "x-intentic-extension": "intruder" },
    });
    expect(intruder.status).toBe(401);
});

test("a signed-in caller is refused in-route, owner or not", async () => {
    // The bearer path resolves an OWNER identity; the role floor waves it through, the handler refuses it.
    const app = appWith(["GET /capabilities/*/connection"]);
    const response = await app.request("http://sandbox.test/capabilities/prod-komodo/connection", {
        headers: { authorization: "Bearer some-google-token" },
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("extension backends");
});

test("an unknown capability answers 404 to a granted caller", async () => {
    const app = appWith(["GET /capabilities/*/connection"]);
    const response = await app.request("http://sandbox.test/capabilities/nowhere/connection", {
        headers: { "x-intentic-extension": "ext-tok" },
    });
    expect(response.status).toBe(404);
});
