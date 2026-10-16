import { ladderPins, roleLadder } from "@intentic/sandbox-contract/models/model-setups";
import type { ModelPin } from "@intentic/sandbox-contract/schemas/agent";
import type { ModelRole } from "@intentic/sandbox-contract/models/model-roles";
import { NATIVE_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import { readyChain } from "@intentic/sandbox-contract/models/model-pins";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import { providerReady } from "./access";
import { modelChoiceLabel } from "./modelPins";
import { demandCatalog, endpointProviders, providerModels } from "./providerCatalog";

// Which models one job will run, and in what order, mirroring the daemon's own rule (contract
// model-pins.ts) for naming the model on a button, drawing settings rows, and showing fallbacks. One
// composable parameterised by role rather than two near-identical ones, since role now declares what
// differed (model-roles.ts).

// Every native provider and configured endpoint, with whether a turn on it can send and the models it can run a turn on,
// as far as its catalog has been read: readyChain takes a pin verbatim, but a preset setup is worked out from these
// (contract model-setups.ts), as the daemon works it out from the same catalogs. Exported so persona models and the
// settings page resolve over the same providers.
export const roleSources = computed(() =>
    [...NATIVE_PROVIDERS, ...endpointProviders.value.map((endpoint) => endpoint.id)].map((provider) => ({
        provider,
        ready: providerReady(provider),
        models: (providerModels.value[provider] ?? []).filter((option) => option.helperOnly === undefined).map((option) => option.value),
    })),
);

// Reads every connected provider's catalog that nothing has read yet, for a preset to be worked out from; a catalog
// already read or loading is left alone (demandCatalog).
export const readConnectedCatalogs = (): void => {
    for (const source of roleSources.value) {
        if (source.ready) {
            demandCatalog(source.provider);
        }
    }
};

export interface RoleModel {
    // Pins this job may run, in daemon try-order, minus gone accounts; empty is a real state, not an error.
    readonly chain: ComputedRef<readonly ModelPin[]>;
    // The pin used when nothing goes wrong; undefined means the caller's own floor answers instead.
    readonly choice: ComputedRef<ModelPin | undefined>;
    readonly label: ComputedRef<string | undefined>;
    // The rest of the chain, for the line describing what happens if the first account is out.
    readonly fallbackLabels: ComputedRef<readonly string[]>;
    // The list the job's setup runs on, as written or as a preset is worked out today. Empty while settings load.
    readonly pinned: ComputedRef<readonly ModelPin[]>;
}

export function useRoleModel(role: ModelRole): RoleModel {
    const { settings } = useSandboxSettings();
    const pinned = computed<readonly ModelPin[]>(() => {
        if (settings.value === undefined) {
            return [];
        }
        const ladder = roleLadder(settings.value, role);
        if (ladder.kind === `preset`) {
            readConnectedCatalogs();
        }
        return ladderPins(ladder, roleSources.value);
    });
    // Settings not loaded yet means no answer, not a guess, since a wrong name would flash on every button.
    const chain = computed<readonly ModelPin[]>(() => (settings.value === undefined ? [] : readyChain(roleSources.value, pinned.value)));
    const choice = computed(() => chain.value[0]);
    return {
        chain,
        choice,
        label: computed(() => (choice.value === undefined ? undefined : modelChoiceLabel(choice.value))),
        fallbackLabels: computed(() => chain.value.slice(1).map(modelChoiceLabel)),
        pinned,
    };
}
