import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createEndpointCatalog } from "./endpoint-catalog.js";

/* WHAT THE PICKER'S ROW SAYS about a model the server named for us. The id is the routing key and is never
 * rewritten; the label is presentation, and a sandbox-run local model arrives with the absolute path of the
 * weights file llama-server loaded, which no picker row can render. */

const catalogOf = async (data: readonly { id: string; display_name?: string }[]) => {
    const dir = await mkdtemp(join(tmpdir(), "endpoint-catalog-"));
    const fetchImpl = (async () =>
        new Response(JSON.stringify({ data }), { headers: { "content-type": "application/json" } })) as unknown as typeof fetch;
    return createEndpointCatalog(dir, fetchImpl).models("local", { baseUrl: "http://127.0.0.1:40100/v1", protocol: "openai" });
};

test("a weights path is labelled by the model, not by where the file sits", async () => {
    const catalog = await catalogOf([{ id: "/work/.intentic/local/cache/models/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf" }]);
    expect(catalog.models).toEqual([
        { id: "/work/.intentic/local/cache/models/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf", label: "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M" },
    ]);
    // The id is what a turn dials, so it survives verbatim, including as the endpoint's default.
    expect(catalog.default).toBe("/work/.intentic/local/cache/models/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf");
});

test("a plain id stands as it is, and a published display name still wins", async () => {
    const catalog = await catalogOf([{ id: "gpt-4o-mini" }, { id: "meta-llama/Llama-3-8B" }, { id: "qwen3-coder", display_name: "Qwen3 Coder" }]);
    expect(catalog.models.map((model) => model.label)).toEqual(["Llama-3-8B", "Qwen3 Coder", "gpt-4o-mini"]);
});
