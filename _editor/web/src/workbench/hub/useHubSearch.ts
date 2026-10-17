import { computed, type ComputedRef, type Ref, shallowRef } from "vue";
import { type HubReader, type HubSearchResult, type HubSource, searchHubs } from "./hubSearch";

// The search the hub's own field and the palette both answer from (hubSearch.ts), over what this reader may open. What
// that is names both hubs and the models behind them, which sit above the workbench, so it is handed in at startup
// (main.ts, shell/hubSearchSources.ts) rather than imported, as the built-in views are (views/registry.ts).

/** Both hubs' pages and cards as this reader may open them, and what their pages know about the reader. */
export interface HubSearchSources {
    readonly sources: ComputedRef<readonly HubSource[]>;
    readonly reader: ComputedRef<HubReader>;
}

const NOTHING = (): HubSearchSources => ({
    sources: computed(() => []),
    reader: computed(() => ({ maker: false, phone: false, app: false, canShip: false })),
});

// allow(module-state): the one composable main.ts provides, before any hub or palette asks
const provided = shallowRef<() => HubSearchSources>(NOTHING);

/** Hands in what is searched; a composable, run in the setup of whoever searches. */
export const provideHubSources = (use: () => HubSearchSources): void => {
    provided.value = use;
};

export function useHubSearch(query: Ref<string>) {
    const { sources, reader } = provided.value();
    const results = computed<readonly HubSearchResult[]>(() => searchHubs(sources.value, reader.value, query.value));
    return { results };
}
