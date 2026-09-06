import type { Model } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { createKimiCatalog } from "./kimi-catalog.js";

test("uses CLIProxyAPI's provider-scoped Kimi definitions and ranks the frontier first", async () => {
    const models = vi.fn(async (): Promise<Model[]> => [
        { id: "kimi-k2.6", label: "Kimi K2.6" },
        { id: "kimi-k3", label: "Kimi K3", description: "Flagship", efforts: ["low", "high", "max"] },
        { id: "kimi-k2.7-code-highspeed", label: "Kimi K2.7 Code HighSpeed" },
        { id: "kimi-k2.7-code", label: "Kimi K2.7 Code" },
    ]);

    const catalog = await createKimiCatalog({ models }).models();

    expect(models).toHaveBeenCalledWith("kimi");
    expect(catalog.models.map((model) => model.id)).toEqual(["kimi-k3", "kimi-k2.7-code", "kimi-k2.7-code-highspeed", "kimi-k2.6"]);
    expect(catalog.models[0]).toEqual({ id: "kimi-k3", label: "Kimi K3", description: "Flagship", efforts: ["low", "high", "max"] });
    expect(catalog.default).toBe("kimi-k3");
});

test("serves a K3 floor while CLIProxyAPI is still booting and retries instead of caching it", async () => {
    const models = vi
        .fn<() => Promise<Model[]>>()
        .mockRejectedValueOnce(new Error("offline"))
        .mockResolvedValueOnce([{ id: "kimi-k4", label: "Kimi K4" }]);
    const catalog = createKimiCatalog({ models });

    const floor = await catalog.models();
    expect(floor.models.map((model) => model.id)).toContain("kimi-k3");
    expect(floor.default).toBe("kimi-k3");
    expect((await catalog.models()).default).toBe("kimi-k4");
    expect(models).toHaveBeenCalledTimes(2);
});
