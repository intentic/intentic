import { createApp } from "../../app.js";
import { services } from "../../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../capabilities-slice.testing.js";
import { proven } from "../../harness/route-client.testing.js";

/* The secret write: an extension token replaces only the credentials of cards its extension contributes, and the
   panel token none, however broad the `POST /capabilities/*\/secret` glob it declared. */

const SENTRY = {
    id: "prod-sentry",
    kind: "cli" as const,
    config: { provider: "sentry", url: "https://sentry.example.com", org: "acme", token: "S-SECRET" },
};

const appWith = () => {
    const capabilities = memoryCapabilitiesStore([SENTRY]);
    const app = createApp(
        services({
            capabilities,
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
                        ? { id: "intentic.connectors", permissions: ["POST /capabilities/*/secret"] }
                        : presented === "other-tok"
                          ? { id: "acme.stranger", permissions: ["POST /capabilities/*/secret"] }
                          : undefined,
                grantFor: (extension) => `extension-token-${extension.id}`,
            },
        }),
    );
    return { app, capabilities };
};

const setSecret = (app: ReturnType<typeof appWith>["app"], headers: Record<string, string>) =>
    app.request("http://sandbox.test/capabilities/prod-sentry/secret", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify({ id: "prod-sentry", value: "ATTACKER-TOKEN" }),
    });

test("an extension that does not contribute the card is refused, and the stored secret stays", async () => {
    const { app, capabilities } = appWith();
    const response = await setSecret(app, { "x-intentic-extension": "other-tok" });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("is not a connection extension");
    expect((await capabilities.get("prod-sentry"))?.config).toMatchObject({ token: "S-SECRET" });
});

test("the panel token can't replace a credential", async () => {
    const { app, capabilities } = appWith();
    const response = await setSecret(app, { "x-intentic-panel": "panel-secret" });
    expect(response.status).toBe(403);
    expect((await capabilities.get("prod-sentry"))?.config).toMatchObject({ token: "S-SECRET" });
});

test("an extension token this daemon never issued is unauthorized", async () => {
    const { app, capabilities } = appWith();
    const response = await setSecret(app, { "x-intentic-extension": "intruder" });
    expect(response.status).toBe(401);
    expect((await capabilities.get("prod-sentry"))?.config).toMatchObject({ token: "S-SECRET" });
});

test("the extension that contributes the card gets past the ownership check", async () => {
    const { app } = appWith();
    const response = await setSecret(app, { "x-intentic-extension": "ext-tok" });
    expect(await response.text()).not.toContain("is not a connection extension");
    expect(response.status).not.toBe(401);
});
