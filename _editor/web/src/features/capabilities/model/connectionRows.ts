import type { CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATEGORIES, type CapabilityCatalogEntry, type CapabilityCategory } from "@intentic/capability-catalog";
import type { CapabilityKind, Device, HostSummary, NetdiskLink, VpnLink, WebExtSummary } from "@intentic/sandbox-contract";
import type { CapabilityConnection, CapabilityConnectionGroup } from "../connect/CapabilityConnections.vue";
import { type ConnectionState, connectionFacts, connectionState, netdiskFacts, vpnFacts } from "./connections";
import { type DeviceConnection, sameMachineNote } from "./deviceConnections";
import type { CatalogTile } from "./slices";
import { entryIcon } from "./tiles";

// What a connection's row says beyond its stored config: its state and its facts line, on the tile that made it and
// in the Connected slice, the inventory of every live connection plus each machine desktop sync alone reaches. Pure
// over the live sources the page reads.

// The live answers no stored config holds: the machine and browser rosters, tunnels and disks as the kernel has them,
// and the daemon's one device registry.
export interface ConnectionSources {
    readonly host: (id: string) => HostSummary | undefined;
    readonly browser: (id: string) => WebExtSummary | undefined;
    readonly vpn: readonly VpnLink[];
    readonly netdisk: readonly NetdiskLink[];
    readonly devices: readonly Device[];
}

// A connection's state, with the machine/browser roster's online answer folded in where there is one.
export const liveState = (entry: CapabilityCatalogEntry, instance: CapabilitySummary, sources: ConnectionSources): ConnectionState =>
    connectionState(entry.kind, instance, (entry.kind === `webext` ? sources.browser(instance.id) : sources.host(instance.id))?.online);

// A device's facts line: its OS, and the other doors onto the same PC when it has any, so two ids that are one
// computer read as one on this screen too.
export const hostFacts = (instance: CapabilitySummary, sources: ConnectionSources): string =>
    [sources.host(instance.id)?.facts?.os ?? connectionFacts(instance), sameMachineNote(sources.devices, instance.id)]
        .filter((fact): fact is string => fact !== undefined && fact !== ``)
        .join(` · `);

// A row on the tile's own list, which states what only a live source knows for a machine or a browser. VPN and disk
// rows are drawn by <VpnConnections> and <NetdiskMounts>, since a link's facts change live.
export const tileRowFacts = (kind: CapabilityKind | undefined, instance: CapabilitySummary, sources: ConnectionSources): string => {
    if (kind === `device`) {
        return hostFacts(instance, sources);
    }
    // A browser names itself and how many sites it may work on; no stored config can answer either.
    if (kind === `webext`) {
        const facts = sources.browser(instance.id)?.facts;
        return facts === undefined
            ? connectionFacts(instance)
            : `${facts.browser} · ${facts.grants.length} site${facts.grants.length === 1 ? `` : `s`} allowed`;
    }
    return connectionFacts(instance);
};

// One row per live connection, carrying its category (for grouping) and a haystack of what a reader would actually
// search for: the name they gave it and the address they typed, neither in any tile's prose.
export type ConnectionRow = CapabilityConnection & { readonly category: CapabilityCategory; readonly rank: number; readonly haystack: string };

export const connectionRow = (tile: CatalogTile, instance: CapabilitySummary, sources: ConnectionSources): ConnectionRow => {
    const state = liveState(tile.entry, instance, sources);
    const facts =
        (tile.entry.kind === `vpn` ? vpnFacts(instance.id, sources.vpn) : undefined) ??
        (tile.entry.kind === `netdisk` ? netdiskFacts(instance.id, sources.netdisk) : undefined) ??
        (tile.entry.kind === `device` ? hostFacts(instance, sources) : connectionFacts(instance));
    // An unnamed connection took the tile's id; the tile is then the name, and the line below is free for facts.
    const named = instance.id !== tile.entry.id;
    return {
        title: named ? instance.id : tile.entry.name,
        tile: named ? tile.entry.name : undefined,
        entryId: tile.entry.id,
        id: instance.id,
        logo: tile.entry.logo,
        icon: entryIcon(tile.entry),
        detail: facts,
        state: state.label,
        tone: state.tone,
        // Only shown where something is outstanding, so a working connection's row stays quiet.
        note: state.rank <= 1 ? instance.status.detail : undefined,
        code: state.rank <= 1 ? instance.status.code : undefined,
        category: tile.entry.category,
        rank: state.rank,
        haystack: `${instance.id} ${tile.entry.name} ${tile.entry.kind} ${facts}`.toLowerCase(),
    };
};

// A machine reached by desktop sync alone, stated on the tile it would be connected on. Its word and colour come from
// the Devices board's own rules; the note is what this tile can't do with it yet.
export const deviceConnectionRow = (tile: CatalogTile, device: DeviceConnection): ConnectionRow => ({
    title: device.title,
    tile: tile.entry.name,
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
    haystack: `${device.machine} ${tile.entry.name} ${tile.entry.kind} ${device.detail}`.toLowerCase(),
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
        return grouped.length === 0 ? [] : [{ label: category.label, rows: grouped }];
    });
