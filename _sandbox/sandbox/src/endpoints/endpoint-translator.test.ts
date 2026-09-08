import { TRIAL_ENDPOINT_ID, TRIAL_MODEL_ID } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { services, withTranslator } from "../harness/route-services.testing.js";
import { memoryCapabilitiesStore } from "../harness/route-stores.testing.js";
import type { Config } from "../env.config.js";
import { withTrialEndpoint } from "../trial/trial-endpoint.js";
import { endpointCompatEntries } from "./endpoint-translator.js";

// The trial's routing entry is static, not derived from the availability probe, so its timing relative to the
// translator's render at boot cannot matter.

const platformConfig = { ...withTranslator, platform: { url: `https://platform.test/` }, connectToken: `tok` } as Config;

const ollama = { id: `ollama`, kind: `endpoint`, config: { baseUrl: `http://host.docker.internal:11434/v1`, protocol: `openai` } } as const;

const trialService = (available: boolean) => ({ available: () => available, status: () => undefined, refresh: async () => undefined });

test("the trial is in the routing table before the availability probe has answered: the fresh-boot render", async () => {
    const sandbox = services({ config: platformConfig });
    // The layered store as composition builds it, probe still unanswered: reads hide the trial.
    const capabilities = withTrialEndpoint(memoryCapabilitiesStore([ollama]), platformConfig, trialService(false), sandbox.platformTunnel);
    const entries = await endpointCompatEntries({
        ...sandbox,
        capabilities,
        endpointModels: { models: async () => ({ models: [{ id: `qwen3`, label: `qwen3` }], default: `qwen3` }), forget: async () => {} },
    });

    const trial = entries.find((entry) => entry.prefix === TRIAL_ENDPOINT_ID);
    expect(trial?.models).toEqual([{ name: TRIAL_MODEL_ID, alias: TRIAL_MODEL_ID }]);
    expect(trial?.["api-key-entries"]).toEqual([{ "api-key": `tok` }]);
    // The user's own endpoint is untouched by the trial's special-casing.
    expect(entries.find((entry) => entry.prefix === `ollama`)?.models).toEqual([{ name: `qwen3`, alias: `qwen3` }]);
});

test("one entry per prefix once the probe HAS answered: the layered capability must not mint a second", async () => {
    const sandbox = services({ config: platformConfig });
    const capabilities = withTrialEndpoint(memoryCapabilitiesStore(), platformConfig, trialService(true), sandbox.platformTunnel);
    const entries = await endpointCompatEntries({
        ...sandbox,
        capabilities,
        // Reached only if the trial were treated as a discovered endpoint again; its model is constant, never fetched.
        endpointModels: {
            models: async () => {
                throw new Error(`the trial's entry must not fetch a catalog`);
            },
            forget: async () => {},
        },
    });

    expect(entries.filter((entry) => entry.prefix === TRIAL_ENDPOINT_ID)).toHaveLength(1);
});

test("a sandbox with no platform carries no trial entry: there is nothing to point it at", async () => {
    const sandbox = services({ config: withTranslator });
    const entries = await endpointCompatEntries({
        ...sandbox,
        capabilities: memoryCapabilitiesStore(),
        endpointModels: { models: async () => ({ models: [], default: `` }), forget: async () => {} },
    });

    expect(entries).toEqual([]);
});
