import { CAPABILITY_CATALOG, capabilityFieldAvailable } from "./index.js";

test("GPU access is a local/self-hosted field; other Docker fields remain available on hosted machines", () => {
    const docker = CAPABILITY_CATALOG.find((entry) => entry.id === "docker")!;
    expect(capabilityFieldAvailable(docker, "gpu", true)).toBe(false);
    expect(capabilityFieldAvailable(docker, "gpu", false)).toBe(true);
    expect(capabilityFieldAvailable(docker, "registryMirror", true)).toBe(true);
});
