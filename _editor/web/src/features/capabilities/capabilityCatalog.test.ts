// Pins the catalog pane's wiring: the rail's slice read from and written to the URL, the grid a slice and the filter
// leave, the Connected slice's rows (synced machines included) under the same filter, and what "nothing matches" is
// judged against on each.
import type { CapabilityRecommendation, CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, contributionEntry } from "@intentic/capability-catalog";
import type { CapabilityContribution } from "@intentic/extension-manifest";
import { effectScope, type EffectScope, ref } from "vue";
import { useCapabilityCatalog } from "./capabilityCatalog";
import type { ConnectionSources } from "./model/connectionRows";
import type { DeviceConnection } from "./model/deviceConnections";

// A connector bringing a client binary, so its grid tile carries a badge only its contribution knows about.
const SENTRY: CapabilityContribution = {
    id: `sentry`,
    kind: `cli`,
    catalog: { name: `Sentry`, category: `observability`, description: `Errors and traces.` },
    fields: [{ key: `token`, label: `Token`, secret: true }],
    env: { SENTRY_TOKEN: `\${token}` },
    skill: `skills/sentry/SKILL.md`,
    pack: `sentry-cli`,
};
const LINUX: CapabilityCatalogEntry = {
    id: `linux`,
    name: `Linux PC`,
    kind: `device`,
    category: `devices`,
    description: `Your Linux PC.`,
    fields: [{ key: `platform`, label: ``, value: `linux` }],
};
const catalogEntry = (id: string): CapabilityCatalogEntry => CAPABILITY_CATALOG.find((entry) => entry.id === id)!;
const connection = (id: string, kind: CapabilitySummary[`kind`], config: Record<string, string>): CapabilitySummary => ({
    id,
    kind,
    status: { state: `active` },
    config,
    secrets: [],
});
const SOURCES: ConnectionSources = { host: () => undefined, browser: () => undefined, vpn: [], netdisk: [], devices: [] };
// A laptop syncing files, listed on the Linux tile it has not been connected on.
const SYNCED: DeviceConnection = {
    id: `device:rog`,
    entryId: `linux`,
    title: `rog`,
    detail: `Linux`,
    state: `live`,
    tone: `success`,
    rank: 3,
    note: `no command access`,
    machine: `rog`,
};

const scopes: EffectScope[] = [];
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

const catalogAt = (slice: string, filter = ``) => {
    const state = {
        entries: ref([contributionEntry(SENTRY), LINUX, catalogEntry(`vpn`), catalogEntry(`ssh`)]),
        capabilities: ref([connection(`office`, `vpn`, { provider: `wireguard` })]),
        recommendationFor: (tile: string): CapabilityRecommendation | undefined =>
            tile === `ssh` ? { entry: `ssh`, evidence: `deploy/hosts.ini`, reason: `your deploys go over SSH`, prefill: {} } : undefined,
        scope: ref(slice),
        search: ref(filter),
        sources: ref(SOURCES),
        syncOnly: ref([SYNCED]),
        contributionOf: (kind: string, id: string) => (kind === SENTRY.kind && id === SENTRY.id ? SENTRY : undefined),
    };
    const scope = effectScope();
    scopes.push(scope);
    return { state, catalog: scope.run(() => useCapabilityCatalog(state))! };
};
const labels = (groups: readonly { readonly label: string }[]): string[] => groups.map((group) => group.label);

describe(`the rail`, () => {
    it(`offers the slices the tiles fill, and lands on the one the URL names`, () => {
        const { catalog } = catalogAt(`servers`);

        expect(catalog.pinnedScopes.value.map((scope) => scope.key)).toEqual([``, `connected`, `recommended`]);
        expect(catalog.categoryScopes.value.map((scope) => scope.key)).toEqual([`observability`, `devices`, `servers`]);
        expect([catalog.activeScope.value.key, catalog.railScope.value, catalog.inCategory.value]).toEqual([`servers`, `servers`, true]);
        expect(catalog.description.value).toBe(`Give the agent remote machines over SSH, private networks over VPN, and the disks on them.`);
    });

    it(`writes a pick back to the URL's slice, and reads an unknown slice as All`, () => {
        const { state, catalog } = catalogAt(`no-such-slice`);
        expect([catalog.activeScope.value.key, catalog.inCategory.value]).toEqual([``, false]);

        catalog.railScope.value = `devices`;
        expect(state.scope.value).toBe(`devices`);
        expect(catalog.activeScope.value.label).toBe(`Your devices`);
    });
});

describe(`the grid`, () => {
    it(`shows the slice's tiles under their headings, narrowed by the filter`, () => {
        const { state, catalog } = catalogAt(``);
        expect(labels(catalog.groupedCatalog.value)).toEqual([`Observability`, `Your devices`, `Servers`]);

        state.search.value = `SSH`;
        expect(catalog.groupedCatalog.value.map((group) => [group.label, group.entries.map((tile) => tile.entry.id)])).toEqual([
            [`Servers`, [`ssh`]],
        ]);
        expect(catalog.nothingMatches.value).toBe(false);

        state.search.value = `stripe`;
        expect(catalog.nothingMatches.value).toBe(true);
    });

    it(`follows the list as connections arrive`, () => {
        const { state, catalog } = catalogAt(`connected`);
        expect(catalog.tiles.value.find((tile) => tile.entry.id === `ssh`)?.connected).toBe(0);

        state.capabilities.value = [...state.capabilities.value, connection(`ops`, `ssh`, { host: `ops.acme.dev` })];
        expect(catalog.tiles.value.find((tile) => tile.entry.id === `ssh`)?.connected).toBe(1);
    });

    it(`badges a tile with what its contribution bakes into the image`, () => {
        const { catalog } = catalogAt(``);

        expect(catalog.badgeEffects(contributionEntry(SENTRY))).toEqual([{ kind: `image` }]);
    });
});

describe(`the Connected slice`, () => {
    it(`lists the connections themselves, and the machines only syncing, under the same filter`, () => {
        const { state, catalog } = catalogAt(`connected`);
        expect(catalog.showingConnections.value).toBe(true);
        expect(catalog.connectionGroups.value.map((group) => [group.label, group.rows.map((row) => row.id)])).toEqual([
            [`Your devices`, [`device:rog`]],
            [`Servers`, [`office`]],
        ]);

        state.search.value = `rog`;
        expect(labels(catalog.connectionGroups.value)).toEqual([`Your devices`]);
        // Judged against the rows on screen, not the grid the slice replaced.
        state.search.value = `sentry`;
        expect([catalog.connectionGroups.value, catalog.nothingMatches.value]).toEqual([[], true]);
    });
});
