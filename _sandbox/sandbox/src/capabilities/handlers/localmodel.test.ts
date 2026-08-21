import { expect, test } from "vitest";
import { packFragment, readPack } from "../../environment/packs.js";
import { registry } from "../registry.js";

// The environment-dependent paths (the download, the panel session, the health probe) are exercised
// end-to-end; here we pin the contracts other code trusts, the docker.test.ts split: the fragment's directive
// (what the rebuild executors allowlist) and the echo (what the vault derives its complement from).

test("the CPU fragment is the llamacpp pack alone: nothing to rebuild where the base image bakes it", async () => {
    // Pinned against the pack's own content and its presence against the stamp (docker.test.ts explains why):
    // a stamped standard image composes nothing at all, which is the rebuild-free add the card promises.
    expect((await readPack("llamacpp"))!.content).toContain("llama-server");
    const engine = await packFragment("llamacpp");
    const fragment = await registry.localmodel.fragment?.({ model: "owner/repo/m.gguf", gpu: "off" });
    expect(fragment === undefined || fragment.includes("llama-server")).toBe(true);
    expect((fragment !== undefined && fragment !== "") === (engine !== undefined)).toBe(true);
    expect(fragment ?? "").not.toContain("--gpus");
});

/* The GPU option's two halves, and only two, no toolkit and no nested runtime: llama-server runs directly in
 * this container, so the allowlisted directive (the docker card's own spelling) plus the CUDA build IS the
 * whole grant. The CUDA pack replaces the CPU binary at the same path, which is why the handler's command
 * line never forks on the build it got. */
test("the gpu option adds the passthrough directive and the CUDA build", async () => {
    const fragment = (await registry.localmodel.fragment?.({ model: "owner/repo/m.gguf", gpu: "on" })) ?? "";
    expect(fragment).toContain("# intentic:runtime --gpus=all");
    expect((await readPack("llamacpp-cuda"))!.content).toContain("GGML_CUDA=ON");
    const cuda = await packFragment("llamacpp-cuda");
    expect(fragment.includes("GGML_CUDA=ON")).toBe(cuda !== undefined);
});

// Off is the default and the absence is total, the docker rule: an overlay that never asked must not carry a
// directive a host could refuse.
test("gpu off leaves no directive in the fragment", async () => {
    const fragment = (await registry.localmodel.fragment?.({ model: "owner/repo/m.gguf" })) ?? "";
    expect(fragment).not.toContain("intentic:runtime");
});

// The echo is the vault's complement: nothing on this card is a credential (public weights, an unauthenticated
// loopback server), so every field must echo, `url` included, the one an incomplete echo would silently vault
// into a manifest entry that can never validate again (secret-fields.test.ts is the per-kind guard).
test("the echo carries every field", () => {
    expect(registry.localmodel.echo({ model: "custom", gpu: "on", url: "https://example.com/m.gguf" }, new Map())).toEqual({
        model: "custom",
        gpu: true,
        url: "https://example.com/m.gguf",
    });
    expect(registry.localmodel.echo({ model: "owner/repo/m.gguf", gpu: "off" }, new Map())).toEqual({ model: "owner/repo/m.gguf", gpu: false });
});

// The one hard refusal: a card that cannot name which bytes to fetch must not be stored gesturing at a
// download nothing can perform. Soft everywhere else (missing binary, pending rebuild), those store.
test("apply refuses a custom model with no URL before anything is stored", async () => {
    const generator = registry.localmodel.apply({} as never, "m", { model: "custom", gpu: "off" });
    await expect(generator.next()).rejects.toThrow(/GGUF URL/);
});
