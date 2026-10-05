import { CapabilitySchema, type DeviceFacts, ProviderKeysAppliedSchema, ProviderKeysSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { createApp } from "../app.js";
import { memoryCapabilitiesStore } from "../capabilities/capabilities-slice.testing.js";
import { postJson, rejectForbidden } from "../harness/route-client.testing.js";
import { services } from "../harness/route-services.testing.js";
import type { HostHub } from "../hosts/host-peer.js";
import { machine } from "../migrations/host-machine.testing.js";

/* GET /arrivals/keys and POST /arrivals/keys/apply over the daemon's own app: registered, gated, and never echoing a key. */

const LAPTOP = CapabilitySchema.parse({ id: "laptop", kind: "device", config: { platform: "linux" } });
const LAPTOP_FACTS: DeviceFacts = { os: "Ubuntu 24.04", arch: "x64", shell: "bash", home: "/home/me", roots: ["/home/me"] };

// One device online with a Hermes `.env` in its home folder.
const withDevice = () => {
    const { hub } = machine({
        "/home/me": null,
        "/home/me/.hermes/.env": "OPENROUTER_API_KEY=test-openrouter-key-0002\n",
    });
    return services({
        capabilities: memoryCapabilitiesStore([LAPTOP]),
        hostHub: unstubbed<HostHub>("hostHub", {
            connected: () => [],
            online: (id: string) => id === "laptop",
            state: () => ({ online: true, facts: LAPTOP_FACTS }),
            mcp: hub.mcp,
        }),
    });
};

test("no connected device is an empty list", async () => {
    const app = createApp(services({ capabilities: memoryCapabilitiesStore([]) }));
    const response = await app.request("/arrivals/keys");
    expect(response.status).toBe(200);
    expect(ProviderKeysSchema.parse(await response.json())).toEqual({ keys: [] });
});

test("a device's key is listed by its last four characters, never its value", async () => {
    const response = await createApp(withDevice()).request("/arrivals/keys");
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).not.toContain("test-openrouter-key");
    expect(ProviderKeysSchema.parse(JSON.parse(text)).keys).toEqual([
        {
            id: expect.stringMatching(/^key-[0-9a-f]{16}$/),
            provider: "openrouter",
            label: "OpenRouter",
            source: "hermes",
            host: "laptop",
            hint: "0002",
            applicable: true,
            added: false,
        },
    ]);
});

test("apply takes ids only, and names one that is gone rather than failing the call", async () => {
    const app = createApp(withDevice());
    expect((await postJson(app, "/arrivals/keys/apply", {})).status).toBe(400);
    expect((await postJson(app, "/arrivals/keys/apply", { ids: [] })).status).toBe(400);

    const response = await postJson(app, "/arrivals/keys/apply", { ids: ["key-0000000000000000"] });
    expect(response.status).toBe(200);
    expect(ProviderKeysAppliedSchema.parse(await response.json())).toEqual({
        added: [],
        failed: [{ id: "key-0000000000000000", error: "that key is no longer on a connected device" }],
    });
});

test("a caller below maintainer is refused both", async () => {
    const app = createApp(services({ capabilities: memoryCapabilitiesStore([]), auth: { authorize: rejectForbidden } }));
    expect((await app.request("/arrivals/keys", { headers: { authorization: "Bearer someone" } })).status).toBe(403);
    expect(
        (
            await app.request("/arrivals/keys/apply", {
                method: "POST",
                headers: { authorization: "Bearer someone", "content-type": "application/json" },
                body: JSON.stringify({ ids: ["key-0000000000000000"] }),
            })
        ).status,
    ).toBe(403);
});
