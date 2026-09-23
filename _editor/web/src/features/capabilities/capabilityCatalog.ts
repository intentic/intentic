import type { CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import { computed, type Ref } from "vue";
import { type ConnectionSources, connectionRows, groupConnections } from "./model/connectionRows";
import type { DeviceConnection } from "./model/deviceConnections";
import { type ContributionOf, tileBadges } from "./model/effects";
import { activeScopeOf, CONNECTED, catalogTiles, groupTiles, matching, railScopes, sliceDescription, tilesInScope } from "./model/slices";
import { entryHaystack } from "./model/tiles";

// The catalog pane: the rail's slices, the grid a slice and the filter leave, and the Connected slice, which answers
// "what have I got" with the connections themselves, named and stated, rather than as a shorter grid.

export interface CatalogHost {
    readonly entries: Readonly<Ref<readonly CapabilityCatalogEntry[]>>;
    readonly capabilities: Readonly<Ref<readonly CapabilitySummary[]>>;
    readonly recommendationFor: (tile: string) => CapabilityRecommendation | undefined;
    // The slice and the filter, both kept in the URL.
    readonly scope: Ref<string>;
    readonly search: Readonly<Ref<string>>;
    readonly sources: Readonly<Ref<ConnectionSources>>;
    // Machines desktop sync alone reaches, listed on the tile that would connect them.
    readonly syncOnly: Readonly<Ref<readonly DeviceConnection[]>>;
    readonly contributionOf: ContributionOf;
}

export const useCapabilityCatalog = ({ entries, capabilities, recommendationFor, scope, search, sources, syncOnly, contributionOf }: CatalogHost) => {
    const tiles = computed(() => catalogTiles(entries.value, capabilities.value, recommendationFor));
    const rail = computed(() => railScopes(tiles.value));
    const pinnedScopes = computed(() => rail.value.pinned);
    const categoryScopes = computed(() => rail.value.categories);
    const activeScope = computed(() => activeScopeOf(rail.value, scope.value));
    const railScope = computed<string>({ get: () => activeScope.value.key, set: (value) => (scope.value = value) });
    const inCategory = computed(() => categoryScopes.value.some((entry) => entry.key === activeScope.value.key));
    const groupedCatalog = computed(() =>
        groupTiles(matching(tilesInScope(tiles.value, activeScope.value.key), search.value, (tile) => entryHaystack(tile.entry))),
    );
    const connections = computed(() => connectionRows(tiles.value, syncOnly.value, sources.value));
    const connectionGroups = computed(() => groupConnections(matching(connections.value, search.value, (row) => row.haystack)));
    const showingConnections = computed(() => activeScope.value.key === CONNECTED);
    const nothingMatches = computed(() => (showingConnections.value ? connectionGroups.value.length === 0 : groupedCatalog.value.length === 0));
    const description = computed(() => sliceDescription(activeScope.value.key));
    return {
        tiles,
        pinnedScopes,
        categoryScopes,
        activeScope,
        railScope,
        inCategory,
        groupedCatalog,
        connectionGroups,
        showingConnections,
        nothingMatches,
        description,
        badgeEffects: (entry: CapabilityCatalogEntry) => tileBadges(entry, contributionOf),
    };
};
