import type { CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATEGORIES, type CapabilityCatalogEntry, instancesOf } from "@intentic/capability-catalog";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import type { CapabilityScope } from "../connect/CapabilityRail.vue";
import { CATEGORY_ICONS } from "./tiles";

// The catalog's slices: every tile with the facts the rail, the grid and the Connected slice read, the rail's rows,
// and which tiles a slice and a filter leave on screen. Pure over the tile list; the page reads the slice off the URL.

// A tile with the facts all three panes read, computed once rather than per tile. Instances ride along so the
// Connected slice need not re-derive them.
export interface CatalogTile {
    readonly entry: CapabilityCatalogEntry;
    readonly instances: readonly CapabilitySummary[];
    readonly connected: number;
    readonly recommendation: CapabilityRecommendation | undefined;
}

export const catalogTiles = (
    entries: readonly CapabilityCatalogEntry[],
    capabilities: readonly CapabilitySummary[],
    recommendationFor: (tile: string) => CapabilityRecommendation | undefined,
): CatalogTile[] =>
    entries.map((entry) => {
        const instances = instancesOf(entry, capabilities);
        return { entry, instances, connected: instances.length, recommendation: recommendationFor(entry.id) };
    });

// The slices the rail offers beyond categories, and the spelling of "no slice at all".
export const ALL = ``;
export const CONNECTED = `connected`;
export const RECOMMENDED = `recommended`;

const scopeOf = (key: string, label: string, icon: IconName, subset: readonly { connected: number }[]): CapabilityScope => ({
    key,
    label,
    icon,
    total: subset.length,
    connected: subset.filter((tile) => tile.connected > 0).length,
});

const countOf = (total: number, one: string, many: string): string => `${total} ${total === 1 ? one : many}`;

export interface RailScopes {
    readonly all: CapabilityScope;
    // All, then a cross-cutting row only once it holds something, not as a promise of an empty page.
    readonly pinned: readonly CapabilityScope[];
    // A category with no tiles is not a row; several stay empty until the extension that fills them is enabled.
    readonly categories: readonly CapabilityScope[];
}

export const railScopes = (tiles: readonly CatalogTile[]): RailScopes => {
    const all = scopeOf(ALL, `All capabilities`, `bolt`, tiles);
    const connected = tiles.filter((tile) => tile.connected > 0);
    const recommended = tiles.filter((tile) => tile.recommendation !== undefined);
    // Counts connections, not tiles: one tile can hold several (two Reddit accounts, three SSH boxes).
    const connections = tiles.reduce((total, tile) => total + tile.connected, 0);
    const pinned = [all];
    if (connected.length > 0) {
        // Counts connections so its number matches the list it opens; `meta` spells that out for the tooltip.
        pinned.push({
            key: CONNECTED,
            label: t(`capabilities.capabilities.connected2`),
            icon: `check-circle`,
            total: connections,
            connected: connections,
            meta: `${countOf(connections, `connection`, `connections`)} across ${countOf(connected.length, `capability`, `capabilities`)}`,
        });
    }
    if (recommended.length > 0) {
        pinned.push(scopeOf(RECOMMENDED, `Recommended`, `sparkles`, recommended));
    }
    const categories = CAPABILITY_CATEGORIES.flatMap((category) => {
        const subset = tiles.filter((tile) => tile.entry.category === category.id);
        return subset.length === 0 ? [] : [scopeOf(category.id, category.label, CATEGORY_ICONS[category.id], subset)];
    });
    return { all, pinned, categories };
};

// An unknown slice (stale link, or Connected once empty) falls back to All rather than a blank grid.
export const activeScopeOf = (scopes: RailScopes, key: string): CapabilityScope =>
    [...scopes.pinned, ...scopes.categories].find((scope) => scope.key === key) ?? scopes.all;

// Tiles a slice covers; Connected renders them as connection rows instead (connectionRows). Anything else is a category.
export const tilesInScope = (tiles: readonly CatalogTile[], key: string): readonly CatalogTile[] => {
    if (key === ALL) {
        return tiles;
    }
    if (key === CONNECTED) {
        return tiles.filter((tile) => tile.connected > 0);
    }
    if (key === RECOMMENDED) {
        return tiles.filter((tile) => tile.recommendation !== undefined);
    }
    return tiles.filter((tile) => tile.entry.category === key);
};

// The filter's text against each item's haystack, case-blind; an empty filter keeps everything.
export const matching = <T>(items: readonly T[], search: string, haystack: (item: T) => string): readonly T[] => {
    const needle = search.trim().toLowerCase();
    return needle === `` ? items : items.filter((item) => haystack(item).includes(needle));
};

// Tiles grouped into display sections in category order; empty sections dropped, derived tiles ordered first.
export const groupTiles = (tiles: readonly CatalogTile[]): { readonly label: string; readonly entries: readonly CatalogTile[] }[] =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const entries = tiles.filter((tile) => tile.entry.category === category.id);
        return entries.length === 0 ? [] : [{ label: category.label, entries }];
    });

const SLICE_DESCRIPTIONS: Readonly<Record<string, string>> = {
    [CONNECTED]: `Every connection your agent can reach right now. Open one to change it, to add another of the same kind, or to take it away.`,
    [RECOMMENDED]: `Suggested from what is checked out in your workspace, each one is something your own code already asks for.`,
};
const CATALOG_DESCRIPTION = `Grow your sandbox: each capability gives your agent new tools or connects your accounts. Everything is stored only in your sandbox.`;

// The page's description follows the active slice, or the category's hint, or falls back to the catalog blurb.
export const sliceDescription = (key: string): string =>
    SLICE_DESCRIPTIONS[key] ?? CAPABILITY_CATEGORIES.find((category) => category.id === key)?.hint ?? CATALOG_DESCRIPTION;
