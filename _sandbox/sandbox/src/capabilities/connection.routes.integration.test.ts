import { createApp } from "../app.js";
import { services } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "./capabilities-slice.testing.js";
import { proven } from "../harness/route-client.testing.js";

/* The connection route: the extension BACKENDS' credential read. */

const KOMODO = {
    id: "prod-komodo",
    kind: "cli" as const,
    config: { provider: "komodo", url: "https://komodo.example.com", apiKey: "K-KEY", apiSecret: "K-SECRET" },
};

// Auth ENABLED (the grants middleware only exists on the exposed daemon) with an extension backend holding
// two minted tokens whose declared reach is exactly this route: the shipped connectors extension, which contributes the
// komodo card, and a stranger that contributes nothing of it.
const appWith = (permissions: readonly string[]) =>
    createApp(
        services({
            capabilities: memoryCapabilitiesStore([KOMODO]),
            auth: { authorize: async () => proven("owner@example.com", "owner") },
            extensionBackend: {
                start: async () => {},
                restart: () => {},
                stop: () => {},
                status: () => ({ state: "stopped", extensions: [] }),
                statusOf: () => undefined,
                proxyTarget: () => undefined,
                isToolPath: () => false,
                verifyExtensionToken: (presented) =>
                    presented === "ext-tok"
                        ? { id: "intentic.connectors", permissions }
                        : presented === "other-tok"
                          ? { id: "acme.stranger", permissions }
                          : undefined,
                grantFor: (extension) => `extension-token-${extension.id}`,
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

// The glob only says an extension reads connections at all; which ones is the card's own contribution. An extension
// declaring `GET /capabilities/*/connection` does not thereby read another extension's card, nor does the panel token.
test("an extension reads only the connections of cards it contributes, and the panel token none", async () => {
    const app = appWith(["GET /capabilities/*/connection"]);
    const stranger = await app.request("http://sandbox.test/capabilities/prod-komodo/connection", {
        headers: { "x-intentic-extension": "other-tok" },
    });
    expect(stranger.status).toBe(403);
    expect(await stranger.text()).not.toContain("K-SECRET");
    const panel = await app.request("http://sandbox.test/capabilities/prod-komodo/connection", {
        headers: { "x-intentic-panel": "panel-secret" },
    });
    expect(panel.status).toBe(403);
    expect(await panel.text()).not.toContain("K-SECRET");
});
