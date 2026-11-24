import { CAPABILITY_CATEGORIES, type CapabilityCatalogEntry, type CapabilityCategory } from "@intentic/capability-catalog";
import type { CapabilityKind, CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { CapabilityConnection, CapabilityConnectionGroup } from "../connect/CapabilityConnections.vue";
import { type ConnectionState, connectionState, hostPresence } from "../../../models/capabilities/connections";
import type { DeviceConnection } from "./deviceConnections";
import { type ConnectionSources, rowFactsOf } from "./rowFacts";
import { categoryLabel, entryName } from "../../../models/capabilities/catalogCopy";
import type { CatalogTile } from "./slices";
import { entryIcon } from "../../../models/capabilities/tiles";

export type { ConnectionSources } from "./rowFacts";

// What a connection's row says beyond its stored config: its state and its facts line, on the tile that made it and
// in the Connected slice, the inventory of every live connection plus each machine desktop sync alone reaches. Pure
// over the live sources the page reads.

// A connection's state, with a machine's presence read off the roster where it is one.
export const liveState = (entry: CapabilityCatalogEntry, instance: CapabilitySummary, sources: ConnectionSources): ConnectionState =>
    connectionState(entry.kind, instance, entry.kind === `device` ? hostPresence(sources.host(instance.id)) : undefined);

// A row's facts line, on the tile's own list and in the Connected slice alike: the kind's own live facts where it has
// them (rowFacts.ts `ROW_FACTS`), else what its stored config says. Tunnel and disk rows on their tile are drawn by
// <LiveLinkRows>, which reads the live link itself. Not read through kindSlots.ts: the Sandbox map imports this file,
// and the slot registry would bring every pairing dialog into the map's graph.
export const tileRowFacts = (kind: CapabilityKind | undefined, instance: CapabilitySummary, sources: ConnectionSources): string =>
    rowFactsOf(kind, instance, sources);

// One row per live connection, carrying its category (for grouping) and a haystack of what a reader would actually
// search for: the name they gave it and the address they typed, neither in any tile's prose.
export type ConnectionRow = CapabilityConnection & { readonly category: CapabilityCategory; readonly rank: number; readonly haystack: string };

// A tile answers the filter to its English name and to the one on screen, when the reader's language has another.
const searchedNames = (entry: CatalogTile[`entry`]): string => {
    const name = entryName(entry);
    return name === entry.name ? name : `${entry.name} ${name}`;
};

export const connectionRow = (tile: CatalogTile, instance: CapabilitySummary, sources: ConnectionSources): ConnectionRow => {
    const state = liveState(tile.entry, instance, sources);
    const facts = tileRowFacts(tile.entry.kind, instance, sources);
    // An unnamed connection took the tile's id; the tile is then the name, and the line below is free for facts.
    const named = instance.id !== tile.entry.id;
    const name = entryName(tile.entry);
    return {
        title: named ? instance.id : name,
        tile: named ? name : undefined,
        entryId: tile.entry.id,
        id: instance.id,
        logo: tile.entry.logo,
        icon: entryIcon(tile.entry),
        detail: facts,
        state: state.label,
        tone: state.tone,
        // Only shown where something is outstanding, so a working connection's row stays quiet; the roster's own word
        // first, where it knows better than the stored status (a PC up only through its distro).
        note: state.rank <= 1 ? (state.note ?? instance.status.detail) : undefined,
        code: state.rank <= 1 ? instance.status.code : undefined,
        category: tile.entry.category,
        rank: state.rank,
        haystack: `${instance.id} ${searchedNames(tile.entry)} ${tile.entry.kind} ${facts}`.toLowerCase(),
    };
};

// A machine reached by desktop sync alone, stated on the tile it would be connected on. Its word and colour come from
// the Devices board's own rules; the note is what this tile can't do with it yet.
export const deviceConnectionRow = (tile: CatalogTile, device: DeviceConnection): ConnectionRow => ({
    title: device.title,
    tile: entryName(tile.entry),
    entryId: tile.entry.id,
    id: device.id,
    logo: tile.entry.logo,
    icon: entryIcon(tile.entry),
    detail: device.detail,
    state: device.state,
    tone: device.tone,
    note: device.note,
    category: tile.entry.category,
    rank: device.rank,
    haystack: `${device.machine} ${searchedNames(tile.entry)} ${tile.entry.kind} ${device.detail}`.toLowerCase(),
});

export const connectionRows = (tiles: readonly CatalogTile[], devices: readonly DeviceConnection[], sources: ConnectionSources): ConnectionRow[] => [
    ...tiles.flatMap((tile) => tile.instances.map((instance) => connectionRow(tile, instance, sources))),
    // Joined to the catalog here, so a machine whose tile this sandbox lacks is dropped by the rule that makes tiles exist.
    ...devices.flatMap((device) => {
        const tile = tiles.find((candidate) => candidate.entry.id === device.entryId);
        return tile === undefined ? [] : [deviceConnectionRow(tile, device)];
    }),
];

// Same headings as the grid; sorted within each group so a row needing attention rises past its group, not past others.
export const groupConnections = (rows: readonly ConnectionRow[]): CapabilityConnectionGroup[] =>
    CAPABILITY_CATEGORIES.flatMap((category) => {
        const grouped = rows
            .filter((row) => row.category === category.id)
            .toSorted((left, right) => left.rank - right.rank || left.id.localeCompare(right.id));
        return grouped.length === 0 ? [] : [{ label: categoryLabel(category), rows: grouped }];
    });
