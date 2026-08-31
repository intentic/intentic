import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { services } from "../route-testing.js";
import { contextShortfall } from "./context-budget.js";

/* WHETHER A TURN IS SENT AT ALL, when the model has published how much it will take.
 *
 * The case these are written from: a sandbox-run 3B model serving 16,384 tokens, asked "Are you there?", which
 * came back `400 request (49181 tokens) exceeds the available context size (16384 tokens)`. The words never
 * reached it. Everything asserted below is the same question asked one layer earlier, where there is still
 * something useful to say about it. */

// The id as the catalog holds it. What it looks like is llama-server's business (it names the model by the
// weights file it loaded, and endpoint-catalog.ts covers that labelling); nothing here turns on its shape.
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
    // What the model takes, what the turn needs, and what the loop itself costs: a refusal that names none of
    // them is one the user can only answer by guessing.
    expect(shortfall?.message).toContain("16,384 tokens");
    expect(shortfall?.message).toContain("22,004");
    expect(shortfall?.message).toContain("20,000");
    // And the ways out, since "too small" without them is a dead end. This entry is a model the SANDBOX runs, so
    // the cheapest way out is a field on its own card and the refusal has to name that field: the version of this
    // sentence that said "raise the context size the server was started with" was sending the one person who
    // could fix it in ten seconds off to look for a command line they never typed.
    expect(shortfall?.message).toContain("card");
    expect(shortfall?.message).not.toMatch(/server was started with/i);
});

/* THE OTHER HALF OF THAT SENTENCE, and the reason it is not one sentence: a user-added endpoint is somebody
 * else's server, started somewhere we cannot see with flags we cannot offer. Naming a card there would be
 * inventing a control, so the advice goes back to the only place the number really lives. */
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

/* THE THREE WAYS THIS MUST STAY QUIET, each of them a turn that would otherwise be refused on something nobody
 * measured. Unknown is not small: a server that publishes no window, a provider that has no such concept, and a
 * runtime whose fixed cost has never been measured all mean "we cannot answer this", and the honest response to
 * a question we cannot answer is to let the provider have its say. */

test("a server that published no window gates nothing", async () => {
    const sandbox = await withEndpoint([{ id: "mystery", label: "mystery" }]);

    expect(await contextShortfall(sandbox, turnOn("mystery"))).toBeUndefined();
});

test("a native provider is never measured against an endpoint's window", async () => {
    const sandbox = await withEndpoint([{ id: LOCAL_MODEL, label: "tiny", contextWindow: 16_384 }]);

    expect(await contextShortfall(sandbox, { provider: "claude", runtime: "claude-code", model: "claude-opus-5", prompt: "hi" })).toBeUndefined();
});

/* The trial is an endpoint and is still asked nothing: its model id is synthetic, the platform picks the real
 * model per message, and a catalog read here would reintroduce the failure harness-credentials.ts removed, a
 * platform blip at plan time refusing a turn the translator could have served. `endpointModels` is left
 * unstubbed on purpose, so a read would throw rather than pass quietly. */
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

/* A PIN THE SERVER HAS DROPPED is measured against the model that will actually answer, not against the dead
 * id: the credential resolver falls back to the catalog default (routedModel), so reading the pin's window would
 * budget a turn for a model nobody is about to dial. Here the pin is gone and the default is enormous, so the
 * turn goes. */
test("a stale pin is measured against the model the turn will really run on", async () => {
    const sandbox = await withEndpoint([{ id: "qwen3-coder", label: "Qwen3 Coder", contextWindow: 131_072 }]);

    expect(await contextShortfall(sandbox, turnOn("a-model-this-server-dropped"))).toBeUndefined();
});

// The opening turn is the one that carries the map and the retrieved-context capsule, so the prompt is part of
// the arithmetic rather than a rounding error: the same model that serves a short message can refuse a long one.
test("what was composed counts: a big preamble is what tips a borderline window over", async () => {
    const sandbox = await withEndpoint([{ id: "mid", label: "mid", contextWindow: 24_000 }]);

    expect(await contextShortfall(sandbox, turnOn("mid", "hi"))).toBeUndefined();
    expect(await contextShortfall(sandbox, turnOn("mid", "x".repeat(12_000)))).toMatchObject({ window: 24_000 });
});
