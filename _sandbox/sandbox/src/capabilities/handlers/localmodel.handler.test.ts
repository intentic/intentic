import { expect, test } from "vitest";
import { packFragment, readPack } from "../../environment/packs.js";
import { estimatedModelMemory, serverCommand } from "./localmodel.handler.js";
import { registry } from "../registry.js";

// Pins two contracts other code trusts: the fragment's directive (what rebuild executors allowlist) and the echo (what
// the vault derives its complement from).

test("the CPU fragment is the llamacpp pack alone: nothing to rebuild where the base image bakes it", async () => {
    // Asserted against the pack's own content and the stamp, not the image the suite happens to run in.
    expect((await readPack("llamacpp"))!.content).toContain("llama-server");
    const engine = await packFragment("llamacpp");
    const fragment = await registry.localmodel.fragment?.({ model: "owner/repo/m.gguf", gpu: "off" });
    expect(fragment === undefined || fragment.includes("llama-server")).toBe(true);
    expect((fragment !== undefined && fragment !== "") === (engine !== undefined)).toBe(true);
    expect(fragment ?? "").not.toContain("--gpus");
});

// Only two halves, no toolkit or nested runtime: llama-server runs directly in this container. The CUDA pack replaces
// the CPU binary at the same path, so the command line never forks on which build it got.
test("the gpu option adds the passthrough directive and the CUDA build", async () => {
    const fragment = (await registry.localmodel.fragment?.({ model: "owner/repo/m.gguf", gpu: "on" })) ?? "";
    expect(fragment).toContain("# intentic:runtime --gpus=all");
    expect((await readPack("llamacpp-cuda"))!.content).toContain("GGML_CUDA=ON");
    const cuda = await packFragment("llamacpp-cuda");
    expect(fragment.includes("GGML_CUDA=ON")).toBe(cuda !== undefined);
});

// Off is the default and the absence is total: an overlay that never asked must not carry a directive a host could
// refuse.
test("gpu off leaves no directive in the fragment", async () => {
    const fragment = (await registry.localmodel.fragment?.({ model: "owner/repo/m.gguf" })) ?? "";
    expect(fragment).not.toContain("intentic:runtime");
});

test("llama-server leaves GPU layers on auto-fit instead of forcing every layer into VRAM", () => {
    const before = process.env["SANDBOX_GPU"];
    process.env["SANDBOX_GPU"] = "all";
    try {
        const command = serverCommand("/models/m.gguf", 12_345, 100_000);
        expect(command).toContain("--gpu-layers auto --fit on");
        expect(command).not.toContain("-ngl 999");
    } finally {
        if (before === undefined) {
            delete process.env["SANDBOX_GPU"];
        } else {
            process.env["SANDBOX_GPU"] = before;
        }
    }
});

test("the admission estimate accounts for weights, q8 KV cache and runtime headroom", () => {
    expect(estimatedModelMemory(16_000_000_000, 32_768)).toBe(19_000_000_000);
    expect(estimatedModelMemory(16_000_000_000, 98_304)).toBe(23_000_000_000);
});

// Every field must echo, `url` included: nothing here is a credential, and an incomplete echo would vault a field into
// a manifest entry that can never validate again.
test("the echo carries every field", () => {
    expect(
        registry.localmodel.echo(
            { model: "custom", gpu: "on", url: "https://example.com/m.gguf", context: "custom", contextTokens: 98_304 },
            new Map(),
        ),
    ).toEqual({
        model: "custom",
        gpu: true,
        url: "https://example.com/m.gguf",
        context: "custom",
        contextTokens: 98_304,
    });
    expect(registry.localmodel.echo({ model: "owner/repo/m.gguf", gpu: "off", context: "65536" }, new Map())).toEqual({
        model: "owner/repo/m.gguf",
        gpu: false,
        context: "65536",
    });
});

// The one hard refusal: a card that can't name which bytes to fetch must not be stored gesturing at a download nothing
// can perform. Everywhere else (missing binary, pending rebuild) is soft and stores.
test("apply refuses a custom model with no URL before anything is stored", async () => {
    const generator = registry.localmodel.apply({} as never, "m", { model: "custom", gpu: "off" });
    await expect(generator.next()).rejects.toThrow(/GGUF URL/);
});
