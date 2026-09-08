import { type ModelPin, type ModelRole, NATIVE_PROVIDERS, readyChain } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../../sandbox/overview/useSandboxSettings";
import { providerReady } from "../session/access";
import { modelChoiceLabel } from "../models/modelPins";
import { endpointProviders } from "./providerCatalog";

// Which models one job will run, and in what order, mirroring the daemon's own rule (contract
// model-pins.ts) for naming the model on a button, drawing settings rows, and showing fallbacks. One
// composable parameterised by role rather than two near-identical ones, since role now declares what
// differed (model-roles.ts).

// Every native provider and configured endpoint, with whether a turn on it can send; no catalogs read
// since readyChain takes a pin verbatim. Exported so persona models resolve over the same providers.
export const roleSources = computed(() =>
    [...NATIVE_PROVIDERS, ...endpointProviders.value.map((endpoint) => endpoint.id)].map((provider) => ({
        provider,
        ready: providerReady(provider),
        models: [],
    })),
);

export interface RoleModel {
    // Pins this job may run, in daemon try-order, minus gone accounts; empty is a real state, not an error.
    readonly chain: ComputedRef<readonly ModelPin[]>;
    // The pin used when nothing goes wrong; undefined means the caller's own floor answers instead.
    readonly choice: ComputedRef<ModelPin | undefined>;
    readonly label: ComputedRef<string | undefined>;
    // The rest of the chain, for the line describing what happens if the first account is out.
    readonly fallbackLabels: ComputedRef<readonly string[]>;
    // The stored setting, as the user wrote it. Empty while settings load.
    readonly pinned: ComputedRef<readonly ModelPin[]>;
}

export function useRoleModel(role: ModelRole): RoleModel {
    const { settings } = useSandboxSettings();
    const pinned = computed<readonly ModelPin[]>(() => settings.value?.modelRoles[role] ?? []);
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
