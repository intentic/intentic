import { compareCheapestFirst, NATIVE_PROVIDERS, type QuickModelChoice, quickModelKey, resolveQuickModel } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { useSandboxSettings } from "../sandbox/useSandboxSettings";
import { providerReady } from "./access";
import { modelOptionsFor, providerDisplayLabel } from "./conversation";

/* WHICH MODEL THE ONE-CLICK HELPERS RUN, browser-side — the same rule the daemon resolves before it spends the
 * call (contract quick-model.ts), read here for the two things only a UI needs: NAMING the model in the
 * sparkle's tooltip, and rendering the settings row's "Auto (…)" label.
 *
 * Both are the discoverability path for the setting, which is the reason it can afford to live on a settings
 * page at all: the button says which model it will use and where to change it, so nobody has to go looking for
 * a control they never knew existed. That only works if this answer and the daemon's are the same answer, which
 * is why the rule is in the contract rather than in either of them. */

// Every native provider, as the resolver sees it: whether a turn on it can be sent (the same predicate the
// picker's rows and the connect gate use) and what its catalog holds. Options come from the live daemon catalog
// with the static seed floor beneath it, so this is answerable before any catalog has loaded.
const quickModelSources = computed(() =>
    NATIVE_PROVIDERS.map((provider) => ({
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

export interface QuickModel {
    // Undefined while settings are loading, and — once they have — when nothing is connected at all.
    readonly choice: ComputedRef<QuickModelChoice | undefined>;
    readonly label: ComputedRef<string | undefined>;
    // The stored setting: "" for Auto, else `${provider}:${model}`. Empty while settings load.
    readonly pinned: ComputedRef<string>;
}

export function useQuickModel(): QuickModel {
    const { settings } = useSandboxSettings();
    const pinned = computed(() => settings.value?.quickModel ?? ``);
    // Settings not loaded yet ⇒ no answer rather than the Auto answer: reporting Auto here would flash the
    // wrong model name in the tooltip of anyone who has pinned one.
    const choice = computed(() => (settings.value === undefined ? undefined : resolveQuickModel(quickModelSources.value, pinned.value)));
    return {
        choice,
        label: computed(() => (choice.value === undefined ? undefined : quickModelLabel(choice.value))),
        pinned,
    };
}
