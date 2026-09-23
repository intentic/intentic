// Pins the catalog's slices: which rail rows exist and what they count, the slice an unknown key falls back to, which
// tiles a slice and a filter leave on the grid, and the sentence the page describes each slice with.
import type { CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATEGORIES, type CapabilityCatalogEntry, type CapabilityCategory } from "@intentic/capability-catalog";
import { describe, expect, it } from "bun:test";
import { entryHaystack } from "./tiles";
import {
    ALL,
    activeScopeOf,
    CONNECTED,
    type CatalogTile,
    catalogTiles,
    groupTiles,
    matching,
    RECOMMENDED,
    railScopes,
    sliceDescription,
    tilesInScope,
} from "./slices";

// Connector tiles as an extension contributes them: `provider` pins each tile's own id, which is what joins a
// connection to the tile that made it.
const entry = (id: string, name: string, category: CapabilityCategory): CapabilityCatalogEntry => ({
    id,
    name,
    kind: `cli`,
    category,
    description: `${name} as agent tools.`,
    fields: [{ key: `provider`, label: ``, value: id }],
});
const connection = (id: string, provider: string): CapabilitySummary => ({
    id,
    kind: `cli`,
    status: { state: `active` },
    config: { provider },
    secrets: [],
});
const asked = (tile: string): CapabilityRecommendation => ({
    entry: tile,
    evidence: `api/.gitlab-ci.yml`,
    reason: `your code asks for it`,
    prefill: {},
});

const GITHUB = entry(`github`, `GitHub`, `code`);
const GITLAB = entry(`gitlab`, `GitLab`, `code`);
const SENTRY = entry(`sentry`, `Sentry`, `observability`);
const POSTGRES = entry(`postgres`, `Postgres`, `data`);

// Two GitHub accounts, a recommended GitLab, and two tiles nobody touched.
const tiles = catalogTiles([GITHUB, GITLAB, SENTRY, POSTGRES], [connection(`github`, `github`), connection(`github-ada`, `github`)], (tile) =>
    tile === `gitlab` ? asked(`gitlab`) : undefined,
);
const ids = (subset: readonly CatalogTile[]): string[] => subset.map((tile) => tile.entry.id);

describe(`the catalog's tiles`, () => {
    it(`carry the connections each tile made and the recommendation behind it`, () => {
        expect(tiles.map((tile) => [tile.entry.id, tile.instances.map((instance) => instance.id), tile.connected, tile.recommendation])).toEqual([
            [`github`, [`github`, `github-ada`], 2, undefined],
            [`gitlab`, [], 0, asked(`gitlab`)],
            [`sentry`, [], 0, undefined],
            [`postgres`, [], 0, undefined],
        ]);
    });
});

describe(`the rail`, () => {
    it(`pins All, then Connected counting connections rather than tiles, then Recommended`, () => {
        const scopes = railScopes(tiles);

        expect(scopes.all).toEqual({ key: ALL, label: `All capabilities`, icon: `bolt`, total: 4, connected: 1 });
        expect(scopes.pinned).toEqual([
            scopes.all,
            { key: CONNECTED, label: `Connected`, icon: `check-circle`, total: 2, connected: 2, meta: `2 connections across 1 capability` },
            { key: RECOMMENDED, label: `Recommended`, icon: `sparkles`, total: 1, connected: 0 },
        ]);
    });

    it(`offers a cross-cutting row only once it holds something`, () => {
        const quiet = catalogTiles([GITHUB, SENTRY], [], () => undefined);

        expect(railScopes(quiet).pinned.map((scope) => scope.key)).toEqual([ALL]);
    });

    it(`lists only the categories that have tiles, in the catalog's order`, () => {
        expect(railScopes(tiles).categories).toEqual([
            { key: `code`, label: `Code & issues`, icon: `code`, total: 2, connected: 1 },
            { key: `observability`, label: `Observability`, icon: `wave-pulse`, total: 1, connected: 0 },
            { key: `data`, label: `Data`, icon: `database`, total: 1, connected: 0 },
        ]);
    });

    it(`lands an unknown or emptied slice on All rather than a blank grid`, () => {
        const scopes = railScopes(tiles);

        expect(activeScopeOf(scopes, `data`).key).toBe(`data`);
        expect(activeScopeOf(scopes, CONNECTED).key).toBe(CONNECTED);
        expect(activeScopeOf(scopes, `no-such-slice`)).toBe(scopes.all);
        // Connected once nothing is connected: the row is gone, and so is the slice.
        expect(activeScopeOf(railScopes(catalogTiles([GITHUB], [], () => undefined)), CONNECTED).key).toBe(ALL);
    });
});

describe(`the grid`, () => {
    it(`covers every tile, the connected ones, the recommended ones, or one category`, () => {
        expect(tilesInScope(tiles, ALL)).toBe(tiles);
        expect(ids(tilesInScope(tiles, CONNECTED))).toEqual([`github`]);
        expect(ids(tilesInScope(tiles, RECOMMENDED))).toEqual([`gitlab`]);
        expect(ids(tilesInScope(tiles, `code`))).toEqual([`github`, `gitlab`]);
    });

    it(`filters by the words a tile is known by, trimmed and case-blind, and keeps everything for an empty filter`, () => {
        const haystack = (tile: CatalogTile): string => entryHaystack(tile.entry);

        expect(matching(tiles, `  `, haystack)).toBe(tiles);
        expect(ids(matching(tiles, ` GIT `, haystack))).toEqual([`github`, `gitlab`]);
        expect(ids(matching(tiles, `cli`, haystack))).toEqual([`github`, `gitlab`, `sentry`, `postgres`]);
        expect(matching(tiles, `stripe`, haystack)).toEqual([]);
    });

    it(`groups what is left under the catalog's headings, dropping the empty ones`, () => {
        expect(groupTiles(tiles).map((group) => [group.label, ids(group.entries)])).toEqual([
            [`Code & issues`, [`github`, `gitlab`]],
            [`Observability`, [`sentry`]],
            [`Data`, [`postgres`]],
        ]);
        expect(groupTiles([])).toEqual([]);
    });
});

describe(`the page's description`, () => {
    it(`follows the slice, then the category's hint, then the catalog's blurb`, () => {
        expect(sliceDescription(CONNECTED)).toBe(
            `Every connection your agent can reach right now. Open one to change it, to add another of the same kind, or to take it away.`,
        );
        expect(sliceDescription(RECOMMENDED)).toBe(
            `Suggested from what is checked out in your workspace, each one is something your own code already asks for.`,
        );
        for (const category of CAPABILITY_CATEGORIES) {
            expect(sliceDescription(category.id)).toBe(category.hint);
        }
        expect(sliceDescription(ALL)).toBe(
            `Grow your sandbox: each capability gives your agent new tools or connects your accounts. Everything is stored only in your sandbox.`,
        );
    });
});
