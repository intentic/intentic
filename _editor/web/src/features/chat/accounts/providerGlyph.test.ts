/* WHAT A PROVIDER WITH NO BRAND MARK LOOKS LIKE. */
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { beforeEach, expect, it } from "vitest";
import { endpointProviders, providerGlyph } from "./providerCatalog";

beforeEach(() => {
    endpointProviders.value = [];
});

it(`draws the trial, a local model and a remote endpoint apart`, () => {
    endpointProviders.value = [
        { id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` },
        { id: `endpoint/qwen3-coder-30b`, label: `qwen3-coder-30b`, kind: `localmodel` },
        { id: `endpoint/ollama`, label: `ollama`, kind: `endpoint` },
    ];

    expect(providerGlyph(TRIAL_PROVIDER)).toBe(`gift`);
    expect(providerGlyph(`endpoint/qwen3-coder-30b`)).toBe(`cpu`);
    expect(providerGlyph(`endpoint/ollama`)).toBe(`server`);
});

it(`falls to the generic glyph for an installed agent, which brings its own vendor`, () => {
    expect(providerGlyph(`acp/opencode`)).toBe(`sparkles`);
});
