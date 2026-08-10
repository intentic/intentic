import {
    compareCheapestFirst,
    NATIVE_PROVIDERS,
    parsePinned,
    type QuickModelChoice,
    quickModelKey,
    resolveQuickModels,
} from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import { providerReady } from "./access";
import { endpointProviders, modelOptionsFor, providerDisplayLabel } from "./providerCatalog";

/* WHICH MODELS THE ONE-CLICK HELPERS RUN, AND IN WHAT ORDER, browser-side — the same rule the daemon walks
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
// catalog has loaded. Endpoints are in the list because their models are in the OPTIONS below — a pin the daemon
// would honour but this side dropped would name one model in the settings row and run another.
const quickModelSources = computed(() =>
    [...NATIVE_PROVIDERS, ...endpointProviders.value.map((endpoint) => endpoint.id)].map((provider) => ({
        provider,
        ready: providerReady(provider),
        models: modelOptionsFor(provider).map((option) => option.value),
    })),
);

// Every model a user could pin, cheapest-first within each provider and grouped by it — the settings row's
// option list. Only READY providers: pinning a model this sandbox has no credential for would resolve straight
// back to Auto, so offering it would be offering a no-op.
export interface QuickModelGroup {
    readonly provider: string;
    readonly label: string;
    readonly options: readonly { readonly key: string; readonly label: string }[];
}

export const quickModelGroups = computed<readonly QuickModelGroup[]>(() =>
    quickModelSources.value
        .filter((source) => source.ready && source.models.length > 0)
        .map((source) => ({
            provider: source.provider,
            label: providerDisplayLabel(source.provider),
            options: modelOptionsFor(source.provider)
                .toSorted((left, right) => compareCheapestFirst(left.value, right.value))
                .map((option) => ({ key: quickModelKey({ provider: source.provider, model: option.value }), label: option.label })),
        })),
);

// The model's published label, falling back to the raw id — a pinned id the catalog has not caught up with (the
// picker's custom-model escape hatch) has no label to show, and showing the id is more honest than showing
// nothing.
const modelLabel = (choice: QuickModelChoice): string =>
    modelOptionsFor(choice.provider).find((option) => option.value === choice.model)?.label ?? choice.model;

// What a resolved choice is CALLED, provider included: "Claude Haiku 4.5" already names its vendor, but
// "GPT-OSS 120B" on Google's channel does not, and which account a click spends is the point of naming it.
const quickModelLabel = (choice: QuickModelChoice): string => `${providerDisplayLabel(choice.provider)} · ${modelLabel(choice)}`;

/* One entry of the STORED list, as a person reads it — for the settings row, which has to draw the models the
 * user wrote down rather than the ones that survived resolution. That difference is the whole reason this is
 * separate from the labels above: a pin whose account was disconnected drops out of the chain, and a row that
 * silently stopped drawing it would look like the app had eaten the setting.
 *
 * Falls back to the raw key for a malformed one, which is what a hand-edited settings file can hold. */
export const pinnedQuickModel = (key: string): { readonly choice: QuickModelChoice | undefined; readonly label: string; readonly ready: boolean } => {
    const choice = parsePinned(key);
    if (choice === undefined) {
        return { choice: undefined, label: key, ready: false };
    }
    return { choice, label: quickModelLabel(choice), ready: providerReady(choice.provider) };
};

export interface QuickModel {
    // Every model a helper may run, in the order it will try them — the pinned list, or Auto's own ladder when
    // nothing is pinned. Empty while settings load and when nothing is connected at all.
    readonly chain: ComputedRef<readonly QuickModelChoice[]>;
    // The one that answers when nothing goes wrong, which is what every surface naming the spend up front means
    // by "the quick model". Undefined while settings are loading, and — once they have — with nothing connected.
    readonly choice: ComputedRef<QuickModelChoice | undefined>;
    readonly label: ComputedRef<string | undefined>;
    // The whole chain as people read it, head first — for the tooltip line that says what happens if the first
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
        label: computed(() => (choice.value === undefined ? undefined : quickModelLabel(choice.value))),
        fallbackLabels: computed(() => chain.value.slice(1).map(quickModelLabel)),
        pinned,
    };
}
