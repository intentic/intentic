// Which providers read as one thing: the model picker's lane and the Usage tab's filter pill must
// agree. The ledger's case is harder, since it outlives deleted cards.
import { TRIAL_PROVIDER } from "@intentic/sandbox-contract";
import { beforeEach, expect, it } from "vitest";
import {
    endpointProviders,
    isLocalModelProvider,
    LOCAL_MODELS_GROUP,
    providerDisplayLabel,
    providerGroup,
    providerGroupLabel,
} from "./providerCatalog";

beforeEach(() => {
    endpointProviders.value = [
        { id: TRIAL_PROVIDER, label: `Free trial`, kind: `endpoint` },
        { id: `endpoint/qwen3-5-64k`, label: `qwen3-5-64k`, kind: `localmodel` },
        { id: `endpoint/qwen-3-8-60k`, label: `qwen-3-8-60k`, kind: `localmodel` },
        { id: `endpoint/vllm-box`, label: `vllm-box`, kind: `endpoint` },
    ];
});

it(`folds every card running weights on this machine into one group`, () => {
    expect(providerGroup(`endpoint/qwen3-5-64k`)).toBe(LOCAL_MODELS_GROUP);
    expect(providerGroup(`endpoint/qwen-3-8-60k`)).toBe(LOCAL_MODELS_GROUP);
    expect(providerGroupLabel(LOCAL_MODELS_GROUP)).toBe(`Local models`);
});

it(`leaves a remote endpoint, the trial and a subscription provider their own groups`, () => {
    // A remote server is not local weights, and can be metered, unlike an always-$0 series.
    expect(providerGroup(`endpoint/vllm-box`)).toBe(`endpoint/vllm-box`);
    // The trial is an endpoint the daemon provisioned, not a model running here.
    expect(providerGroup(TRIAL_PROVIDER)).toBe(TRIAL_PROVIDER);
    expect(providerGroup(`claude`)).toBe(`claude`);
    expect(isLocalModelProvider(`acp/opencode`)).toBe(false);
});

// Spend is never pruned, so a deleted card's provider id lingers in the ledger; since nothing there
// says what kind of card it was, a dead id folds in with the local models.
it(`folds an endpoint whose card is gone, which is how the ledger grew a pill per deleted model`, () => {
    expect(providerGroup(`endpoint/llama-test`)).toBe(LOCAL_MODELS_GROUP);
    expect(providerGroup(`endpoint/qwen-3-8-200k`)).toBe(LOCAL_MODELS_GROUP);
});

it(`names a dead endpoint by the id the user typed, never by its provider id`, () => {
    expect(providerDisplayLabel(`endpoint/llama-test`)).toBe(`llama-test`);
    expect(providerDisplayLabel(`endpoint/qwen3-5-64k`)).toBe(`qwen3-5-64k`);
    expect(providerDisplayLabel(`claude`)).toBe(`Claude Code`);
});
