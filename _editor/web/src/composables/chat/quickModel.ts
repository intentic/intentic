import { NATIVE_PROVIDERS, type QuickModelChoice, resolveQuickModels } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import { providerReady } from "./access";
import { modelChoiceLabel } from "./modelPins";
import { endpointProviders, modelOptionsFor } from "./providerCatalog";

/* WHICH MODELS THE ONE-CLICK HELPERS RUN, AND IN WHAT ORDER, browser-side, the same rule the daemon walks
 * before it spends the call (contract quick-model.ts), read here for the three things only a UI needs: NAMING
 * the model in the sparkle's tooltip, rendering the settings row's "Auto (…)" label, and showing the fallbacks
 * underneath it so the order is something you can see rather than something you have to remember.
 *
 * The first two are the discoverability path for the setting, which is the reason it can afford to live on a
 * settings page at all: the button says which model it will use and where to change it, so nobody has to go
 * looking for a control they never knew existed. That only works if this answer and the daemon's are the same
 * answer, which is why the rule is in the contract rather than in either of them. */

// Every native provider AND every configured model endpoint, as the resolver sees it: whether a turn on it can
// be sent (the same predicate the picker's rows and the connect gate use) and what its catalog holds. Options
// come from the live daemon catalog with the static seed floor beneath it, so this is answerable before any
// catalog has loaded. Endpoints are in the list because their models are in the OPTIONS below, a pin the daemon
// would honour but this side dropped would name one model in the settings row and run another.
const quickModelSources = computed(() =>
    [...NATIVE_PROVIDERS, ...endpointProviders.value.map((endpoint) => endpoint.id)].map((provider) => ({
        provider,
        ready: providerReady(provider),
        models: modelOptionsFor(provider).map((option) => option.value),
    })),
);

/* NO OPTION LIST HERE ANY MORE. This file used to publish `quickModelGroups`, every pinnable model grouped by
 * provider and sorted cheapest-first, for the 14rem dropdown the settings row used to offer. That row now opens
 * the app's own model picker (ModelPinPicker → ModelPicker): the same list the composer uses, with its search,
 * its provider rail and its access badges, none of which the grouped copy could carry.
 *
 * The cheap-end ORDER did not go with it, and is not missing: it lives in resolveQuickModels, where it decides
 * what Auto actually runs. What the dropdown added was a hint about which row to pick by hand, and the picker
 * says more about that than a sort could — while `namesThinking` on the row below the picker catches the one
 * mistake this list invites, a reasoning rung pinned to a job meant to be instant. */

export interface QuickModel {
    // Every model a helper may run, in the order it will try them, the pinned list, or Auto's own ladder when
    // nothing is pinned. Empty while settings load and when nothing is connected at all.
    readonly chain: ComputedRef<readonly QuickModelChoice[]>;
    // The one that answers when nothing goes wrong, which is what every surface naming the spend up front means
    // by "the quick model". Undefined while settings are loading, and, once they have, with nothing connected.
    readonly choice: ComputedRef<QuickModelChoice | undefined>;
    readonly label: ComputedRef<string | undefined>;
    // The whole chain as people read it, head first, for the tooltip line that says what happens if the first
    // one is out. Empty when the chain is one model long: there is no fallback to describe.
    readonly fallbackLabels: ComputedRef<readonly string[]>;
    // The stored setting: the ordered `${provider}:${model}` keys, empty for Auto. Empty while settings load.
    readonly pinned: ComputedRef<readonly string[]>;
}

export function useQuickModel(): QuickModel {
    const { settings } = useSandboxSettings();
    const pinned = computed<readonly string[]>(() => settings.value?.quickModel ?? []);
    // Settings not loaded yet ⇒ no answer rather than the Auto answer: reporting Auto here would flash the
    // wrong model name in the tooltip of anyone who has pinned one.
    const chain = computed<readonly QuickModelChoice[]>(() =>
        settings.value === undefined ? [] : resolveQuickModels(quickModelSources.value, pinned.value),
    );
    const choice = computed(() => chain.value[0]);
    return {
        chain,
        choice,
        label: computed(() => (choice.value === undefined ? undefined : modelChoiceLabel(choice.value))),
        fallbackLabels: computed(() => chain.value.slice(1).map(modelChoiceLabel)),
        pinned,
    };
}
