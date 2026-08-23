import { type Capability, LOCAL_MODEL_WINDOW_DEFAULT } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { translatedEndpoints } from "./endpoint-translator.js";
import {
    endpointConfigOf,
    fitsAgentTurn,
    localModelEndpointConfig,
    localModelLabel,
    localModelPort,
    localModelSource,
    localModelWindow,
    localModelWindowLabel,
    mintsEndpointProvider,
} from "./local-model.js";

/* The pure derivations three independent readers trust to agree: the handler that starts llama-server, the
 * translator entry that routes turns at it, and the boot restore that respawns it all re-derive the port and
 * URL from the id alone, so determinism IS the contract. */

test("the port is a pure function of the id, inside the band, and ids differ", () => {
    expect(localModelPort("qwen")).toBe(localModelPort("qwen"));
    for (const id of ["qwen", "llama", "coder", "a", "my-local-model"]) {
        const port = localModelPort(id);
        expect(port).toBeGreaterThanOrEqual(40100);
        expect(port).toBeLessThan(40500);
    }
    expect(localModelPort("qwen")).not.toBe(localModelPort("llama"));
});

test("the derived endpoint is loopback and openai-protocol by construction", () => {
    expect(localModelEndpointConfig("qwen")).toEqual({ baseUrl: `http://127.0.0.1:${localModelPort("qwen")}/v1`, protocol: "openai" });
});

/* endpointConfigOf is THE reader of "which capabilities are endpoints": an endpoint carries its config
 * verbatim, a localmodel derives one, and every other kind is not an endpoint, which is what keeps the
 * translator, the picker route, the credential resolver and the quick-model sources one opinion. */
test("endpointConfigOf answers for both endpoint-minting kinds and nothing else", () => {
    const endpoint: Capability = { id: "ollama", kind: "endpoint", config: { baseUrl: "https://x.example.com/v1", protocol: "anthropic" } };
    expect(endpointConfigOf(endpoint)).toEqual(endpoint.config);
    const local: Capability = {
        id: "qwen",
        kind: "localmodel",
        config: { model: "custom", gpu: "off", context: "65536", url: "https://example.com/m.gguf" },
    };
    expect(endpointConfigOf(local)).toEqual(localModelEndpointConfig("qwen"));
    expect(endpointConfigOf({ id: "docker", kind: "docker", config: { gpu: "off" } })).toBeUndefined();
    expect(mintsEndpointProvider("endpoint")).toBe(true);
    expect(mintsEndpointProvider("localmodel")).toBe(true);
    expect(mintsEndpointProvider("mcp")).toBe(false);
});

test("a Hugging Face path splits into repo + path for hub's downloadFile, cached by file name", () => {
    expect(localModelSource({ model: "unsloth/Qwen3.5-9B-GGUF/Qwen3.5-9B-Q4_K_M.gguf", gpu: "off", context: "65536" })).toEqual({
        repo: "unsloth/Qwen3.5-9B-GGUF",
        path: "Qwen3.5-9B-Q4_K_M.gguf",
        file: "Qwen3.5-9B-Q4_K_M.gguf",
    });
    // A nested path keeps its directories on the repo side of the download and its basename as the cache key.
    expect(localModelSource({ model: "owner/repo/sub/dir/model.gguf", gpu: "off", context: "65536" })).toEqual({
        repo: "owner/repo",
        path: "sub/dir/model.gguf",
        file: "model.gguf",
    });
});

test("the custom escape hatch takes the URL verbatim and keys the cache by its basename, query stripped", () => {
    expect(localModelSource({ model: "custom", gpu: "off", context: "65536", url: "https://example.com/files/m.gguf?download=true" })).toEqual({
        url: "https://example.com/files/m.gguf?download=true",
        file: "m.gguf",
    });
});

// Undefined is a refusal the handler words, never a fallback: both shapes are a card that cannot say which
// bytes to fetch, and a default model here would download gigabytes nobody chose.
test("an unresolvable source is undefined: custom without a url, a path too short to name a file", () => {
    expect(localModelSource({ model: "custom", gpu: "off", context: "65536" })).toBeUndefined();
    expect(localModelSource({ model: "custom", gpu: "off", context: "65536", url: "   " })).toBeUndefined();
    expect(localModelSource({ model: "owner/repo", gpu: "off", context: "65536" })).toBeUndefined();
    expect(localModelSource({ model: "just-a-name", gpu: "off", context: "65536" })).toBeUndefined();
});

// The seam that makes a local model drivable at all: it rides the translator's provider list as the loopback
// endpoint it derives, beside the user-added openai endpoints and never beside an anthropic-protocol one
// (which the harness dials directly and has no business in that list).
test("a local model rides the translator list as its derived endpoint", () => {
    const capabilities: Capability[] = [
        { id: "qwen", kind: "localmodel", config: { model: "owner/repo/m.gguf", gpu: "off", context: "65536" } },
        { id: "gateway", kind: "endpoint", config: { baseUrl: "https://x.example.com/v1", protocol: "anthropic" } },
        { id: "docker", kind: "docker", config: { gpu: "off" } },
    ];
    expect(translatedEndpoints(capabilities)).toEqual([{ id: "qwen", config: localModelEndpointConfig("qwen") }]);
});

test("the label is the file without its extension", () => {
    expect(localModelLabel({ model: "owner/repo/Qwen3.5-9B-Q4_K_M.gguf", gpu: "off", context: "65536" })).toBe("Qwen3.5-9B-Q4_K_M");
    expect(localModelLabel({ model: "custom", gpu: "off", context: "65536", url: "https://example.com/m.gguf" })).toBe("m");
});

/* THE WINDOW IS ONE NUMBER FROM TWO FIELDS, and this is the only place that resolves it, for the reason the port
 * above is derived rather than stored: the flag llama-server is started with, the number the card quotes back,
 * and the line the add prints all have to be the same answer. */
test("a rung resolves to its own token count, a custom entry to the number typed", () => {
    const model = { model: "owner/repo/m.gguf", gpu: "off" } as const;
    expect(localModelWindow({ ...model, context: "16384" })).toBe(16_384);
    expect(localModelWindow({ ...model, context: "131072" })).toBe(131_072);
    expect(localModelWindow({ ...model, context: "custom", contextTokens: 98_304 })).toBe(98_304);
});

// A form cannot submit this; a hand-edited manifest can. The window has a good answer available, so it takes it
// rather than refusing, and the apply says which one it took (localmodel.ts states that asymmetry in full).
test("custom with no number falls back to the default rung", () => {
    expect(localModelWindow({ model: "owner/repo/m.gguf", gpu: "off", context: "custom" })).toBe(Number(LOCAL_MODEL_WINDOW_DEFAULT));
});

// How the number reads wherever it is shown. A typed value that is not a whole multiple keeps its digits: the
// point of the label is to be checkable against what was chosen, so rounding it would be the one thing it must
// not do.
test("windows read as thousands, and an odd one keeps its digits", () => {
    expect(localModelWindowLabel(65_536)).toBe("64k");
    expect(localModelWindowLabel(16_384)).toBe("16k");
    expect(localModelWindowLabel(3_000)).toBe("3000");
});

/* THE FLOOR THE CARD AND THE STATUS ROW BOTH READ. It is the default rung on purpose (the contract argues why):
 * the default is the smallest window a full agent turn fits in, so "below the default" and "quick jobs only" are
 * the same statement, and one of them cannot drift from the other. */
test("the agent floor is the default rung: under it is quick-jobs territory", () => {
    expect(fitsAgentTurn(Number(LOCAL_MODEL_WINDOW_DEFAULT))).toBe(true);
    expect(fitsAgentTurn(131_072)).toBe(true);
    expect(fitsAgentTurn(32_768)).toBe(false);
});
