import { expect, test } from "vitest";
import type { Services } from "../../composition.js";
import { services } from "../../harness/route-services.testing.js";
import { contextShortfall } from "./context-budget.js";

// Whether a turn is sent at all, when a model has published how much context it will take.

// Id as the catalog holds it; its shape (llama-server's own labelling) does not matter here.
const LOCAL_MODEL = "Llama-3.2-3B-Instruct-Q4_K_M";

const withEndpoint = async (models: readonly { id: string; label: string; contextWindow?: number }[]): Promise<Services> => {
    const sandbox = services({
        endpointModels: { models: async () => ({ models: [...models], default: models[0]?.id ?? "" }), forget: async () => {} },
    });
    await sandbox.capabilities.upsert({
        id: "tiny",
        kind: "localmodel",
        config: { model: "meta-llama/x/Llama-3.2-3B-Instruct-Q4_K_M.gguf", gpu: "off", context: "32768" },
    });
    return sandbox;
};

const turnOn = (model: string | undefined, prompt = "Are you there?") =>
    ({ provider: "endpoint/tiny", runtime: "claude-code", model, prompt }) as const;

test("a window that cannot hold the loop's own instructions refuses, naming the three numbers", async () => {
    const sandbox = await withEndpoint([{ id: LOCAL_MODEL, label: "Llama-3.2-3B-Instruct-Q4_K_M", contextWindow: 16_384 }]);

    const shortfall = await contextShortfall(sandbox, turnOn(LOCAL_MODEL));

    expect(shortfall?.window).toBe(16_384);
    // Names all three numbers: what the model takes, what the turn needs, what the loop costs.
    expect(shortfall?.message).toContain("16,384 tokens");
    expect(shortfall?.message).toContain("22,004");
    expect(shortfall?.message).toContain("20,000");
    // Points at the sandbox's own card, not a server flag, since this is a model the sandbox runs.
    expect(shortfall?.message).toContain("card");
    expect(shortfall?.message).not.toMatch(/server was started with/i);
});

test("a window on somebody else's server points at the server, not at a card", async () => {
    const sandbox = services({
        endpointModels: {
            models: async () => ({ models: [{ id: "tiny", label: "tiny", contextWindow: 16_384 }], default: "tiny" }),
            forget: async () => {},
        },
    });
    await sandbox.capabilities.upsert({
        id: "ollama",
        kind: "endpoint",
        config: { baseUrl: "http://host.docker.internal:11434/v1", protocol: "openai" },
    });

    const shortfall = await contextShortfall(sandbox, {
        provider: "endpoint/ollama",
        runtime: "claude-code",
        model: "tiny",
        prompt: "Are you there?",
    });

    expect(shortfall?.message).toMatch(/server was started with/i);
    expect(shortfall?.message).not.toContain("card");
});

test("a window with room for the loop is sent, not second-guessed", async () => {
    const sandbox = await withEndpoint([{ id: "qwen3-coder", label: "Qwen3 Coder", contextWindow: 131_072 }]);

    expect(await contextShortfall(sandbox, turnOn("qwen3-coder"))).toBeUndefined();
});

// Unknown is not small: no published window, no such concept for the provider, or a runtime with no measured floor must
// never gate a turn.

test("a server that published no window gates nothing", async () => {
    const sandbox = await withEndpoint([{ id: "mystery", label: "mystery" }]);

    expect(await contextShortfall(sandbox, turnOn("mystery"))).toBeUndefined();
});

test("a native provider is never measured against an endpoint's window", async () => {
    const sandbox = await withEndpoint([{ id: LOCAL_MODEL, label: "tiny", contextWindow: 16_384 }]);

    expect(await contextShortfall(sandbox, { provider: "claude", runtime: "claude-code", model: "claude-opus-5", prompt: "hi" })).toBeUndefined();
});

// `endpointModels` is left unstubbed on purpose: a catalog read here would throw rather than pass quietly.
test("the free trial is never measured, and never asked", async () => {
    const sandbox = services({});
    await sandbox.capabilities.upsert({
        id: "free-trial",
        kind: "endpoint",
        config: { baseUrl: "https://platform.test/trial/v1", protocol: "openai" },
    });

    expect(await contextShortfall(sandbox, { provider: "endpoint/free-trial", runtime: "claude-code", model: "auto", prompt: "hi" })).toBeUndefined();
});

test("a runtime with no measured floor gates nothing, whatever the window says", async () => {
    const sandbox = await withEndpoint([{ id: LOCAL_MODEL, label: "tiny", contextWindow: 16_384 }]);

    expect(await contextShortfall(sandbox, { provider: "endpoint/tiny", runtime: "acp", model: LOCAL_MODEL, prompt: "hi" })).toBeUndefined();
});

// Falls back to the catalog default (routedModel) rather than the dropped pin's own window.
test("a stale pin is measured against the model the turn will really run on", async () => {
    const sandbox = await withEndpoint([{ id: "qwen3-coder", label: "Qwen3 Coder", contextWindow: 131_072 }]);

    expect(await contextShortfall(sandbox, turnOn("a-model-this-server-dropped"))).toBeUndefined();
});

// The prompt includes the map and retrieved-context capsule, so a short message and a long one can land on different
// sides of a borderline window.
test("what was composed counts: a big preamble is what tips a borderline window over", async () => {
    const sandbox = await withEndpoint([{ id: "mid", label: "mid", contextWindow: 24_000 }]);

    expect(await contextShortfall(sandbox, turnOn("mid", "hi"))).toBeUndefined();
    expect(await contextShortfall(sandbox, turnOn("mid", "x".repeat(12_000)))).toMatchObject({ window: 24_000 });
});
