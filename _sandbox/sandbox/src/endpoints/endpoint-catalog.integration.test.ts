import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createEndpointCatalog } from "./endpoint-catalog.js";

// The id is the routing key, never rewritten; a local model's id is often the weights file's absolute path, which the
// label must not be.

// props undefined means a server with no /props route (every non-llama.cpp gateway); it 404s like the real one instead
// of answering.
const catalogOf = async (data: readonly { id: string; display_name?: string; max_model_len?: number }[], props?: unknown) => {
    const dir = await mkdtemp(join(tmpdir(), "endpoint-catalog-"));
    const fetchImpl = (async (url: string) => {
        if (String(url).endsWith("/props")) {
            return props === undefined
                ? new Response("not found", { status: 404 })
                : new Response(JSON.stringify(props), { headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } });
    }) as unknown as typeof fetch;
    return createEndpointCatalog(dir, fetchImpl).models("local", { baseUrl: "http://127.0.0.1:40100/v1", protocol: "openai" });
};

test("a weights path is labelled by the model, not by where the file sits", async () => {
    const catalog = await catalogOf([{ id: "/work/.intentic/local/cache/models/Qwen3.8-27B-UD-Q4_K_M.gguf" }]);
    expect(catalog.models).toEqual([
        { id: "/work/.intentic/local/cache/models/Qwen3.8-27B-UD-Q4_K_M.gguf", label: "Qwen3.8-27B-UD-Q4_K_M" },
    ]);
    // The id is what a turn dials, so it survives verbatim, including as the endpoint's default.
    expect(catalog.default).toBe("/work/.intentic/local/cache/models/Qwen3.8-27B-UD-Q4_K_M.gguf");
});

test("a plain id stands as it is, and a published display name still wins", async () => {
    const catalog = await catalogOf([{ id: "gpt-4o-mini" }, { id: "meta-llama/Llama-3-8B" }, { id: "qwen3-coder", display_name: "Qwen3 Coder" }]);
    expect(catalog.models.map((model) => model.label)).toEqual(["Llama-3-8B", "Qwen3 Coder", "gpt-4o-mini"]);
});

// How much the server will take, the number a turn is refused against; every case below is about not carrying a wrong
// one.

test("llama.cpp's served window is read off /props and stands for every row that server lists", async () => {
    // The real server's shape: the slot's window after the flag is divided/clamped, unrelated to weights.
    const catalog = await catalogOf([{ id: "/cache/Llama-3.2-3B-Instruct-Q4_K_M.gguf" }], {
        default_generation_settings: { n_ctx: 16_384 },
    });
    expect(catalog.models[0]?.contextWindow).toBe(16_384);
});

test("a row's own max_model_len beats the server-wide probe: one vLLM can serve several models", async () => {
    const catalog = await catalogOf([{ id: "small", max_model_len: 8_192 }, { id: "big", max_model_len: 131_072 }, { id: "quiet" }], {
        default_generation_settings: { n_ctx: 32_768 },
    });
    const windows = Object.fromEntries(catalog.models.map((model) => [model.id, model.contextWindow]));
    expect(windows).toEqual({ small: 8_192, big: 131_072, quiet: 32_768 });
});

test("a server that publishes no window says nothing, and nothing is invented for it", async () => {
    const catalog = await catalogOf([{ id: "gpt-4o-mini" }]);
    expect(catalog.models[0]).toEqual({ id: "gpt-4o-mini", label: "gpt-4o-mini" });
    expect(catalog.models[0]?.contextWindow).toBeUndefined();
});

test("a /props answer in a shape we don't know leaves the window unknown rather than mangled", async () => {
    const catalog = await catalogOf([{ id: "gpt-4o-mini" }], { default_generation_settings: { n_ctx: "lots" }, total_slots: 4 });
    expect(catalog.models[0]?.contextWindow).toBeUndefined();
});
