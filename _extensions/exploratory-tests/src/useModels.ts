import { type CatalogOption, ModelsSchema, modelsFor, PROVIDERS } from "@intentic/sandbox-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, type Ref } from "vue";
import { host } from "./host";

/* The provider + model picker, on the same seam the chat composer and the automations dialog use: the static
 * catalog is the floor (so the control renders before any request lands) and `GET /<provider>/models` is the
 * live list layered on top. Keyed by provider alone — a model list is a property of the provider, not of this
 * view — so switching back and forth is free. */

export const PROVIDER_OPTIONS: readonly CatalogOption[] = PROVIDERS.map(({ label, value }) => ({ label, value }));

/* "Default" is a real choice, not a placeholder: sending no model lets the daemon resolve the provider's own,
 * which is what the user's subscription is pointed at. It carries a SENTINEL value rather than the empty string
 * the wire wants, because a Select whose model value is "" renders its label blank — the control then looks
 * unset while it is in fact set, which is the one thing a picker must never do. `modelForTurn` converts back. */
export const DEFAULT_MODEL_VALUE = "default";
const DEFAULT_MODEL: CatalogOption = { label: `Default`, value: DEFAULT_MODEL_VALUE };

// The value to put on the turn: the sentinel means "say nothing and let the daemon choose".
export const modelForTurn = (selected: string): string => (selected === DEFAULT_MODEL_VALUE ? `` : selected);

export function useModels(provider: Ref<string>) {
    const api = host();
    const query = useQuery({
        queryKey: computed(() => api.sandbox.key(`exploratory`, `models`, provider.value)),
        enabled: computed(() => api.sandbox.reachable()),
        queryFn: async (): Promise<CatalogOption[]> =>
            ModelsSchema.parse(await api.sandbox.json(`/${provider.value}/models`)).models.map((model) => ({ value: model.id, label: model.label })),
    });

    return {
        models: computed<CatalogOption[]>(() => [DEFAULT_MODEL, ...(query.data.value ?? modelsFor(provider.value))]),
        isLoading: query.isLoading,
    };
}
