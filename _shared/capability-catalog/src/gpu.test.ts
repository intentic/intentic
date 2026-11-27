import { CAPABILITY_CATALOG, capabilityFieldAvailable } from "./index.js";

test("GPU access is a local/self-hosted field; other Docker fields remain available on hosted machines", () => {
    const docker = CAPABILITY_CATALOG.find((entry) => entry.id === "docker")!;
    expect(capabilityFieldAvailable(docker, "gpu", true)).toBe(false);
    expect(capabilityFieldAvailable(docker, "gpu", false)).toBe(true);
    expect(capabilityFieldAvailable(docker, "registryMirror", true)).toBe(true);
});

test("a field declaring `hosted` is drawn only on a hosted machine; its neighbours everywhere", () => {
    const card = {
        kind: "cli" as const,
        fields: [
            { key: "botToken", hosted: undefined },
            { key: "wakeOnMention", hosted: true },
        ],
    };
    expect(capabilityFieldAvailable(card, "wakeOnMention", true)).toBe(true);
    expect(capabilityFieldAvailable(card, "wakeOnMention", false)).toBe(false);
    expect(capabilityFieldAvailable(card, "botToken", false)).toBe(true);
    expect(capabilityFieldAvailable(card, "botToken", true)).toBe(true);
});
