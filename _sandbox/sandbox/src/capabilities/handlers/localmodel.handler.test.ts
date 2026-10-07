import { packFragment, readPack } from "../../image/packs.js";
import { serverCommand } from "./localmodel.handler.js";
import { registry } from "../registry.js";

// Pins two contracts other code trusts: the fragment's directive (what rebuild executors allowlist) and the echo (what
// the vault derives its complement from).

test("the CPU fragment is the llamacpp pack alone: nothing to rebuild where the base image bakes it", async () => {
    // Asserted against the pack's own content and the stamp, not the image the suite happens to run in.
    expect((await readPack("llamacpp"))!.content).toContain("llama-server");
    const engine = await packFragment("llamacpp");
    const fragment = await registry.localmodel.fragment?.({ model: "owner/repo/m.gguf" });
    expect(fragment === undefined || fragment.includes("llama-server")).toBe(true);
    expect((fragment !== undefined && fragment !== "") === (engine !== undefined)).toBe(true);
    expect(fragment ?? "").not.toContain("--gpus");
});

// The GPU lane is gone: a stored config that still says `gpu: "on"` composes the CPU pack and no directive, so it
// never asks the host for its GPUs again.
test("an older config that asked for a GPU composes the CPU fragment and no directive", async () => {
    const fragment = (await registry.localmodel.fragment?.({ model: "owner/repo/m.gguf", gpu: "on" } as never)) ?? "";
    expect(fragment).not.toContain("intentic:runtime");
    expect(fragment).not.toContain("--gpus");
    expect(fragment).toBe((await packFragment("llamacpp")) ?? "");
});

test("llama-server serves on the CPU with no GPU flags and no load log", () => {
    const command = serverCommand("/models/m.gguf", 12_345, 100_000);
    expect(command).not.toMatch(/--gpu-layers|-ngl|--fit|--log-file/);
    expect(command).toContain("--ctx-size 100000");
});

// Every field must echo, `url` included: nothing here is a credential, and an incomplete echo would vault a field into
// a manifest entry that can never validate again.
test("the echo carries every field", () => {
    expect(
        registry.localmodel.echo({ model: "custom", url: "https://example.com/m.gguf", context: "custom", contextTokens: 98_304 }, new Map()),
    ).toEqual({
        model: "custom",
        url: "https://example.com/m.gguf",
        context: "custom",
        contextTokens: 98_304,
    });
    expect(registry.localmodel.echo({ model: "owner/repo/m.gguf", context: "65536" }, new Map())).toEqual({
        model: "owner/repo/m.gguf",
        context: "65536",
    });
});

// The one hard refusal: a entry that can't name which bytes to fetch must not be stored gesturing at a download nothing
// can perform. Everywhere else (missing binary, pending rebuild) is soft and stores.
test("apply refuses a custom model with no URL before anything is stored", async () => {
    const generator = registry.localmodel.apply({} as never, "m", { model: "custom" });
    await expect(generator.next()).rejects.toThrow(/GGUF URL/);
});
