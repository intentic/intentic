import { WORKSPACE_ROOT } from "@intentic/constants";
// Pins what a connection's row says beyond its stored config: the state a roster overrules, the facts only a live
// source knows (a machine's OS and its other doors, a browser's sites, a tunnel's address), and how the Connected
// slice orders the inventory it builds from them.
import type { CapabilityStatus, CapabilitySummary } from "@intentic/api-contract";
import { CAPABILITY_CATALOG, type CapabilityCatalogEntry, type CapabilityCategory } from "@intentic/capability-catalog";
import type { Device, HostSummary, NetdiskLink, VpnLink, WebExtSummary } from "@intentic/sandbox-contract";
import {
    type ConnectionRow,
    type ConnectionSources,
    connectionRow,
    connectionRows,
    deviceConnectionRow,
    groupConnections,
    hostFacts,
    liveState,
    tileRowFacts,
} from "./connectionRows";
import type { DeviceConnection } from "./deviceConnections";
import { type CatalogTile, catalogTiles } from "./slices";
import { entryIcon } from "./tiles";

const NOW = 1_700_000_000_000;

// A device tile and a browser tile as their extensions contribute them; the tunnel and disk tiles are the static ones.
const WINDOWS: CapabilityCatalogEntry = {
    id: `windows`,
    name: `Windows PC`,
    kind: `device`,
    category: `devices`,
    description: `Your Windows PC.`,
    fields: [{ key: `platform`, label: ``, value: `windows` }],
};
const CHROME: CapabilityCatalogEntry = {
    id: `chrome`,
    name: `Chrome`,
    kind: `webext`,
    category: `devices`,
    description: `Your own Chrome.`,
    fields: [{ key: `platform`, label: ``, value: `chrome` }],
};
const catalogEntry = (id: string): CapabilityCatalogEntry => CAPABILITY_CATALOG.find((entry) => entry.id === id)!;
const VPN = catalogEntry(`vpn`);
const NETDISK = catalogEntry(`netdisk`);

const instance = (id: string, kind: CapabilitySummary[`kind`], config: Record<string, string>, status: CapabilityStatus = { state: `active` }) =>
    ({ id, kind, status, config, secrets: [] }) satisfies CapabilitySummary;

const host = (id: string, os: string | undefined, online = true): HostSummary => ({
    id,
    platform: `windows`,
    environments: [{ key: `native`, online }],
    online,
    lastSeen: NOW,
    ...(os === undefined ? {} : { facts: { os, arch: `x64`, shell: `pwsh`, home: `C:\\Users\\ada`, roots: [] } }),
});
const browser = (id: string, sites: number): WebExtSummary => ({
    id,
    platform: `chrome`,
    online: true,
    facts: {
        browser: `Chrome 141 on Windows`,
        tabs: 3,
        grants: Array.from({ length: sites }, (_, at) => ({ origin: `https://site${at}.example`, mode: `read` as const })),
        paused: false,
    },
});
const tunnel = (id: string, state: VpnLink[`state`]): VpnLink => ({
    id,
    provider: `wireguard`,
    state,
    address: `10.8.0.2`,
    routes: [`0.0.0.0/0`],
    dns: [],
    autoConnect: true,
});
const disk = (id: string): NetdiskLink => ({
    id,
    provider: `smb`,
    state: `mounted`,
    target: `//nas/share`,
    mountPoint: `${WORKSPACE_ROOT}/nas`,
    access: `readwrite`,
    writable: true,
    autoMount: true,
});

interface Live {
    readonly hosts?: readonly HostSummary[];
    readonly browsers?: readonly WebExtSummary[];
    readonly vpn?: readonly VpnLink[];
    readonly netdisk?: readonly NetdiskLink[];
    readonly devices?: readonly Device[];
}
const sources = (live: Live = {}): ConnectionSources => ({
    host: (id) => live.hosts?.find((candidate) => candidate.id === id),
    browser: (id) => live.browsers?.find((candidate) => candidate.id === id),
    vpn: live.vpn ?? [],
    netdisk: live.netdisk ?? [],
    devices: live.devices ?? [],
});
const tileOf = (entry: CapabilityCatalogEntry, instances: readonly CapabilitySummary[]): CatalogTile =>
    catalogTiles([entry], instances, () => undefined)[0]!;

// One PC reached through two doors of one card: its Windows install and a WSL distro on it.
const ONE_PC: Device[] = [
    { key: `omen`, label: `omen`, hostId: `omen`, online: true, platform: `windows` },
    { key: `omen::wsl:arch`, label: `omen::wsl:arch`, hostId: `omen::wsl:arch`, online: true, platform: `linux` },
];

describe(`a connection's state`, () => {
    it(`reads a connected machine's liveness off the machine roster`, () => {
        const pc = instance(`omen`, `device`, { platform: `windows` });

        expect(liveState(WINDOWS, pc, sources({ hosts: [host(`omen`, undefined)] })).label).toBe(`online`);
        expect(liveState(WINDOWS, pc, sources({ hosts: [host(`omen`, undefined, false)] })).label).toBe(`offline`);
        // Not in the roster at all yet: asleep, not broken.
        expect(liveState(WINDOWS, pc, sources()).label).toBe(`offline`);
    });

    it(`reads a browser by its own status, whatever the machine roster says about the same id`, () => {
        const own = instance(`chrome`, `webext`, { platform: `chrome` });

        expect(liveState(CHROME, own, sources({ hosts: [host(`chrome`, undefined, false)] })).label).toBe(`ready`);
    });
});

describe(`a row's facts`, () => {
    it(`names a machine by the OS it reported, and the other doors onto the same PC`, () => {
        const pc = instance(`omen`, `device`, { platform: `windows`, purpose: `the desk PC` });

        expect(hostFacts(pc, sources({ hosts: [host(`omen`, `Windows 11 Pro`)], devices: ONE_PC }))).toBe(
            `Windows 11 Pro · one PC with omen::wsl:arch`,
        );
        // Never reported: the stored config is all there is to say.
        expect(hostFacts(pc, sources())).toBe(`the desk PC`);
    });

    it(`gives a tile's own rows what only a live source knows, by the tile's kind`, () => {
        const pc = instance(`omen`, `device`, { platform: `windows` });
        const own = instance(`chrome`, `webext`, { platform: `chrome`, purpose: `work profile` });
        const box = instance(`ops`, `ssh`, { host: `ops.acme.dev`, user: `ada` });

        expect(tileRowFacts(`device`, pc, sources({ hosts: [host(`omen`, `Windows 11 Pro`)] }))).toBe(`Windows 11 Pro`);
        expect(tileRowFacts(`webext`, own, sources({ browsers: [browser(`chrome`, 2)] }))).toBe(`Chrome 141 on Windows · 2 sites allowed`);
        expect(tileRowFacts(`webext`, own, sources({ browsers: [browser(`chrome`, 1)] }))).toBe(`Chrome 141 on Windows · 1 site allowed`);
        // A browser that never reported: its stored facts, as any other row.
        expect(tileRowFacts(`webext`, own, sources())).toBe(`work profile`);
        expect(tileRowFacts(`ssh`, box, sources())).toBe(`ops.acme.dev · ada`);
    });
});

describe(`the Connected slice`, () => {
    it(`titles an unnamed connection by its tile and a named one by its own name`, () => {
        const unnamed = instance(`vpn`, `vpn`, { provider: `wireguard` });
        const named = instance(`office`, `vpn`, { provider: `wireguard`, server: `vpn.acme.dev` });
        const tile = tileOf(VPN, [unnamed, named]);

        expect(connectionRow(tile, unnamed, sources({ vpn: [tunnel(`vpn`, `connected`)] }))).toEqual({
            title: VPN.name,
            tile: undefined,
            entryId: `vpn`,
            id: `vpn`,
            logo: VPN.logo,
            icon: entryIcon(VPN),
            detail: `10.8.0.2 · all traffic`,
            state: `ready`,
            tone: `success`,
            note: undefined,
            code: undefined,
            category: `servers`,
            rank: 3,
            haystack: `vpn ${VPN.name.toLowerCase()} vpn 10.8.0.2 · all traffic`,
        });
        // A tunnel that is down says nothing live, so the stored facts stand.
        expect(connectionRow(tile, named, sources({ vpn: [tunnel(`office`, `disconnected`)] }))).toMatchObject({
            title: `office`,
            tile: VPN.name,
            detail: `vpn.acme.dev`,
        });
    });

    it(`states a mounted disk as the kernel has it`, () => {
        const nas = instance(`nas`, `netdisk`, { provider: `smb` });

        expect(connectionRow(tileOf(NETDISK, [nas]), nas, sources({ netdisk: [disk(`nas`)] })).detail).toBe(`/work/nas · read-write`);
    });

    it(`carries the daemon's own sentence and code only while something is outstanding`, () => {
        const stuck = instance(`pc`, `device`, { platform: `windows` }, { state: `pending`, detail: `run the one-liner`, code: `ABCD-1234` });
        const broken = instance(`pc2`, `device`, { platform: `windows` }, { state: `error`, detail: `refused`, code: `E1` });
        const idle = instance(`pc3`, `device`, { platform: `windows` }, { state: `inactive`, detail: `switched off`, code: `OFF` });
        const tile = tileOf(WINDOWS, [stuck, broken, idle]);

        expect(connectionRow(tile, stuck, sources())).toMatchObject({ state: `needs setup`, rank: 1, note: `run the one-liner`, code: `ABCD-1234` });
        expect(connectionRow(tile, broken, sources())).toMatchObject({ state: `error`, rank: 0, note: `refused`, code: `E1` });
        expect(connectionRow(tile, idle, sources())).toMatchObject({ state: `off`, rank: 2, note: undefined, code: undefined });
    });

    it(`states a machine that only syncs on the tile that would connect it`, () => {
        const synced: DeviceConnection = {
            id: `device:rog`,
            entryId: `windows`,
            title: `rog`,
            detail: `Windows`,
            state: `live`,
            tone: `success`,
            rank: 3,
            note: `no command access`,
            machine: `rog`,
        };

        expect(deviceConnectionRow(tileOf(WINDOWS, []), synced)).toEqual({
            title: `rog`,
            tile: `Windows PC`,
            entryId: `windows`,
            id: `device:rog`,
            logo: undefined,
            icon: entryIcon(WINDOWS),
            detail: `Windows`,
            state: `live`,
            tone: `success`,
            note: `no command access`,
            category: `devices`,
            rank: 3,
            haystack: `rog windows pc device windows`,
        });
    });

    it(`lists every connection, then the synced machines whose tile this sandbox carries`, () => {
        const pc = instance(`omen`, `device`, { platform: `windows` });
        const synced = (entryId: string, machine: string): DeviceConnection => ({
            id: `device:${machine}`,
            entryId,
            title: machine,
            detail: ``,
            state: `live`,
            tone: `success`,
            rank: 3,
            note: `no command access`,
            machine,
        });

        const rows = connectionRows([tileOf(WINDOWS, [pc])], [synced(`windows`, `rog`), synced(`macos`, `air`)], sources());

        expect(rows.map((row) => row.id)).toEqual([`omen`, `device:rog`]);
    });

    it(`groups rows under the catalog's headings, what needs attention first within each`, () => {
        const row = (id: string, category: CapabilityCategory, rank: number): ConnectionRow => ({
            title: id,
            entryId: id,
            id,
            icon: `bolt`,
            detail: ``,
            state: ``,
            tone: `neutral`,
            category,
            rank,
            haystack: id,
        });
        const groups = groupConnections([row(`b`, `servers`, 3), row(`a`, `servers`, 3), row(`z`, `servers`, 0), row(`pc`, `devices`, 2)]);

        expect(groups.map((group) => [group.label, group.rows.map((entry) => entry.id)])).toEqual([
            [`Your devices`, [`pc`]],
            [`Servers`, [`z`, `a`, `b`]],
        ]);
    });
});
