/* WHICH PROVIDERS ARE ONE THING TO A READER. Two surfaces fold on this rule and used to disagree: the model
 * picker drew one "Local models" lane while the Usage tab drew a filter pill per card, labelled with the raw
 * `endpoint/<id>` provider id. The ledger's case is the harder one, because it outlives the cards. */
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
    // A server the user pointed us at is not their machine, and it can be metered: on a cost screen that is the
    // difference between a series worth reading and one that is always $0.
    expect(providerGroup(`endpoint/vllm-box`)).toBe(`endpoint/vllm-box`);
    // The trial is an endpoint the daemon provisioned, not a model running here.
    expect(providerGroup(TRIAL_PROVIDER)).toBe(TRIAL_PROVIDER);
    expect(providerGroup(`claude`)).toBe(`claude`);
    expect(isLocalModelProvider(`acp/opencode`)).toBe(false);
});

/* THE LEDGER OUTLIVES THE CARD. Spend is never pruned (a total that shrinks is worse than one that is stale),
 * so a sandbox that tried three sets of weights over an afternoon and deleted them carries three provider ids
 * nothing can connect any more. Each one drew its own filter pill on the Usage tab. Nothing in a ledger row
 * says which KIND of card minted it, so a deleted id folds with the local models: that is what actually
 * produces dead endpoint ids, and it is a display grouping that nothing routes on. */
it(`folds an endpoint whose card is gone, which is how the ledger grew a pill per deleted model`, () => {
    expect(providerGroup(`endpoint/llama-test`)).toBe(LOCAL_MODELS_GROUP);
    expect(providerGroup(`endpoint/qwen-3-8-200k`)).toBe(LOCAL_MODELS_GROUP);
});

it(`names a dead endpoint by the id the user typed, never by its provider id`, () => {
    expect(providerDisplayLabel(`endpoint/llama-test`)).toBe(`llama-test`);
    expect(providerDisplayLabel(`endpoint/qwen3-5-64k`)).toBe(`qwen3-5-64k`);
    expect(providerDisplayLabel(`claude`)).toBe(`Claude Code`);
});
