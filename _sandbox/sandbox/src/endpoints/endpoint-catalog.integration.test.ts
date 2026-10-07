import { WORKSPACE_ROOT } from "@intentic/constants";
import { link, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_MODEL_INSTANT } from "@intentic/sandbox-contract";
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
    const catalog = await catalogOf([{ id: `${WORKSPACE_ROOT}/.intentic/local/cache/models/Qwen3.8-27B-UD-Q4_K_M.gguf` }]);
    expect(catalog.models).toEqual([{ id: "/work/.intentic/local/cache/models/Qwen3.8-27B-UD-Q4_K_M.gguf", label: "Qwen3.8-27B-UD-Q4_K_M" }]);
    // The id is what a turn dials, so it survives verbatim, including as the endpoint's default.
    expect(catalog.default).toBe("/work/.intentic/local/cache/models/Qwen3.8-27B-UD-Q4_K_M.gguf");
});

test("a plain id stands as it is, and a published display name still wins", async () => {
    const catalog = await catalogOf([{ id: "gpt-4o-mini" }, { id: "meta-llama/Llama-3-8B" }, { id: "qwen3-coder", display_name: "Qwen3 Coder" }]);
    expect(catalog.models.map((model) => model.label)).toEqual(["Llama-3-8B", "Qwen3 Coder", "gpt-4o-mini"]);
});

// Refuse turns that exceed the server's advertised capacity.

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

// Ollama and LM Studio say a loaded model's window only on their own APIs; a turn measured against nothing would be
// silently cut at their few-thousand-token defaults.
const nativeCatalog = async (data: readonly { id: string }[], routes: Readonly<Record<string, unknown>>) => {
    const dir = await mkdtemp(join(tmpdir(), "endpoint-catalog-"));
    const fetchImpl = (async (url: string) => {
        const path = new URL(String(url)).pathname;
        if (path in routes) {
            return new Response(JSON.stringify(routes[path]), { headers: { "content-type": "application/json" } });
        }
        return path === "/v1/models"
            ? new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } })
            : new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;
    return createEndpointCatalog(dir, fetchImpl).models("host", { baseUrl: "http://host.docker.internal:11434/v1", protocol: "openai" });
};

test("Ollama's running models carry their window, and a model not loaded yet stays unknown", async () => {
    const catalog = await nativeCatalog([{ id: "qwen3:32b" }, { id: "llama3.2:latest" }], {
        "/api/ps": { models: [{ name: "qwen3:32b", model: "qwen3:32b", size: 1, context_length: 4_096 }] },
    });
    const windows = Object.fromEntries(catalog.models.map((model) => [model.id, model.contextWindow]));
    expect(windows).toEqual({ "qwen3:32b": 4_096, "llama3.2:latest": undefined });
});

test("LM Studio's loaded instance carries its window, by the model's key", async () => {
    const catalog = await nativeCatalog([{ id: "google/gemma-4-26b-a4b" }, { id: "deepseek-r1" }], {
        "/api/v1/models": {
            models: [
                {
                    type: "llm",
                    key: "google/gemma-4-26b-a4b",
                    loaded_instances: [{ id: "google/gemma-4-26b-a4b", config: { context_length: 32_768 } }],
                },
                { type: "llm", key: "deepseek-r1", loaded_instances: [] },
            ],
        },
    });
    const windows = Object.fromEntries(catalog.models.map((model) => [model.id, model.contextWindow]));
    expect(windows).toEqual({ "google/gemma-4-26b-a4b": 32_768, "deepseek-r1": undefined });
});

test("a /props answer in a shape we don't know leaves the window unknown rather than mangled", async () => {
    const catalog = await catalogOf([{ id: "gpt-4o-mini" }], { default_generation_settings: { n_ctx: "lots" }, total_slots: 4 });
    expect(catalog.models[0]?.contextWindow).toBeUndefined();
});

// llama.cpp drops a turn's tools without a word when the template cannot call them, so a positive "no" marks the row;
// the chat picker and the turn door both read the mark.
test("a server whose chat template cannot call tools marks its model as helper-only", async () => {
    const catalog = await catalogOf([{ id: "/cache/gemma-3-4b-it-Q4_K_M.gguf" }], {
        default_generation_settings: { n_ctx: 32_768 },
        chat_template_caps: { supports_tools: false, supports_tool_calls: false, supports_system_role: true },
    });
    expect(catalog.models).toEqual([
        { id: "/cache/gemma-3-4b-it-Q4_K_M.gguf", label: "gemma-3-4b-it-Q4_K_M", contextWindow: 32_768, helperOnly: "no-tool-calls" },
    ]);
});

// Only a positive answer gates: vLLM and remote gateways say nothing, and an older llama.cpp says nothing of tools.
test("a server that says it can call tools, or says nothing about it, leaves the model usable", async () => {
    const able = await catalogOf([{ id: "qwen" }], { chat_template_caps: { supports_tools: true, supports_tool_calls: true } });
    expect(able.models[0]).toEqual({ id: "qwen", label: "qwen" });
    const silent = await catalogOf([{ id: "qwen" }], { default_generation_settings: { n_ctx: 8_192 } });
    expect(silent.models[0]).toEqual({ id: "qwen", label: "qwen", contextWindow: 8_192 });
    const noProps = await catalogOf([{ id: "qwen" }]);
    expect(noProps.models[0]).toEqual({ id: "qwen", label: "qwen" });
});

// Each fact is read on its own, so one in a shape we don't know does not take the other with it.
test("caps in a shape we don't know leave the window standing, and the model usable", async () => {
    const catalog = await catalogOf([{ id: "qwen" }], { default_generation_settings: { n_ctx: 16_384 }, chat_template_caps: "yes" });
    expect(catalog.models[0]).toEqual({ id: "qwen", label: "qwen", contextWindow: 16_384 });
});

// The instant rung is sold as too small for a turn, so it is enforced like one that cannot call tools, whichever card
// serves the weights: llama-server lists them under the path it loaded.
test("the curated quick-jobs model is helper-only by its weights file, and a turn with no model named avoids it", async () => {
    const instant = `/work/.intentic/local/cache/models/${LOCAL_MODEL_INSTANT.id.split("/").at(-1)}`;
    const catalog = await catalogOf([{ id: instant }, { id: `${WORKSPACE_ROOT}/.intentic/local/cache/models/Qwen3.5-9B-Q4_K_M.gguf` }], {
        chat_template_caps: { supports_tool_calls: true },
    });
    expect(catalog.models.find((model) => model.id === instant)?.helperOnly).toBe("instant-tier");
    expect(catalog.default).toBe("/work/.intentic/local/cache/models/Qwen3.5-9B-Q4_K_M.gguf");
    // A server serving only helper-only rows still names one, which the turn's refusal then explains.
    expect((await catalogOf([{ id: instant }])).default).toBe(instant);
});

// The persisted list is what answers once the server stops; a write that truncated it in place would leave a crash's
// half-record there. A rename gives the new list its own file, which the link to the old one shows.
test("the last known list is replaced whole, never rewritten in place", async () => {
    const dir = await mkdtemp(join(tmpdir(), "endpoint-catalog-"));
    await writeFile(join(dir, "local.json"), JSON.stringify([{ id: "old", label: "old" }]));
    await link(join(dir, "local.json"), join(dir, "before.json"));
    const fetchImpl = (async () => Response.json({ data: [{ id: "new" }] })) as unknown as typeof fetch;
    const catalog = createEndpointCatalog(dir, fetchImpl);
    await catalog.models("local", { baseUrl: "http://127.0.0.1:40100/v1", protocol: "openai" });
    expect(JSON.parse(await readFile(join(dir, "local.json"), "utf8"))).toEqual([{ id: "new", label: "new" }]);
    expect(JSON.parse(await readFile(join(dir, "before.json"), "utf8"))).toEqual([{ id: "old", label: "old" }]);
    // And it is the list that answers when the server no longer does.
    const offline = createEndpointCatalog(dir, (async () => new Response("down", { status: 503 })) as unknown as typeof fetch);
    expect((await offline.models("local", { baseUrl: "http://127.0.0.1:40100/v1", protocol: "openai" })).models).toEqual([
        { id: "new", label: "new" },
    ]);
});
