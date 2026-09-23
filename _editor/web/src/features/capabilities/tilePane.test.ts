// Pins what the open tile lists beside its form: the background processes serving its connections (by the extension
// behind each), the synced machines on it, its rows' live state and facts, the singleton's rebuild link, and the
// registry counts and recommendation it shows.
import type { CapabilityRecommendation, CapabilityStatus, CapabilitySummary } from "@intentic/api-contract";
import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { RegistryEntry } from "@intentic/registry";
import type { ExtensionSummary, HostSummary } from "@intentic/sandbox-contract";
import { effectScope, type EffectScope, ref } from "vue";
import type { BackgroundProcessRow } from "../terminal/useBackgroundProcesses";
import type { ConnectionSources } from "./model/connectionRows";
import type { DeviceConnection } from "./model/deviceConnections";
import { servingExtension, tileProcesses, useTilePane } from "./tilePane";

const instance = (id: string, kind: CapabilitySummary[`kind`], config: Record<string, string>, status: CapabilityStatus = { state: `active` }) =>
    ({ id, kind, status, config, secrets: [] }) satisfies CapabilitySummary;
// Two extensions contributing relay connectors: the gateway serving a connection is its own extension's.
const extension = (id: string, connectors: readonly string[]): ExtensionSummary =>
    ({
        id,
        enabled: true,
        manifest: { contributes: { capabilities: connectors.map((connector) => ({ id: connector, kind: `cli` })) } },
    }) as unknown as ExtensionSummary;
const ENABLED = [extension(`intentic.chat`, [`discord`, `slack`]), extension(`intentic.mail`, [`imap`])];
const process = (extensionId: string | undefined, name: string, running = true): BackgroundProcessRow => ({
    id: `${extensionId ?? `session`}/${name}`,
    name,
    ...(extensionId === undefined ? {} : { extensionId, processName: name }),
    running,
});

describe(`the gateways serving a tile`, () => {
    it(`are the processes of the extension behind each connection`, () => {
        expect(servingExtension(instance(`team`, `cli`, { provider: `discord` }), ENABLED)).toBe(`intentic.chat`);
        expect(servingExtension(instance(`inbox`, `cli`, { provider: `imap` }), ENABLED)).toBe(`intentic.mail`);
        // An installed extension serves itself; a connector no enabled extension contributes has no gateway.
        expect(servingExtension(instance(`my-ext`, `extension`, {}), ENABLED)).toBe(`my-ext`);
        expect(servingExtension(instance(`old`, `cli`, { provider: `irc` }), ENABLED)).toBeUndefined();
    });

    it(`list nothing until something is connected, and only what serves it after`, () => {
        const gateway = process(`intentic.chat`, `gateway`);
        const rows = [gateway, process(`intentic.mail`, `poller`, false), process(undefined, `stray`)];

        expect(tileProcesses(rows, [], ENABLED)).toEqual([]);
        expect(tileProcesses(rows, [instance(`team`, `cli`, { provider: `discord` })], ENABLED)).toEqual([gateway]);
    });
});

const LINUX: CapabilityCatalogEntry = {
    id: `linux`,
    name: `Linux PC`,
    kind: `device`,
    category: `devices`,
    description: `Your Linux PC.`,
    fields: [{ key: `platform`, label: ``, value: `linux` }],
};
const WALLET: CapabilityCatalogEntry = {
    id: `wallet`,
    name: `Wallet`,
    kind: `wallet`,
    category: `business`,
    description: `Pay.`,
    fields: [],
    singleton: true,
};
const synced = (entryId: string, machine: string): DeviceConnection => ({
    id: `device:${machine}`,
    entryId,
    title: machine,
    detail: `Linux`,
    state: `live`,
    tone: `success`,
    rank: 3,
    note: `no command access`,
    machine,
});
const host = (id: string, online: boolean): HostSummary => ({
    id,
    platform: `linux`,
    environments: [{ key: `native`, online }],
    online,
    facts: { os: `Ubuntu 24.04`, arch: `x64`, shell: `bash`, home: `/home/ada`, roots: [] },
});
const published = (trust: string): RegistryEntry => ({ trust }) as unknown as RegistryEntry;

const scopes: EffectScope[] = [];
afterEach(() => {
    for (const scope of scopes.splice(0)) {
        scope.stop();
    }
});

const paneOn = (selected: CapabilityCatalogEntry | undefined) => {
    const hosts = [host(`box`, true)];
    const state = {
        selected: ref(selected),
        instances: ref([instance(`box`, `device`, { platform: `linux` })]),
        sources: ref<ConnectionSources>({
            host: (id) => hosts.find((found) => found.id === id),
            browser: () => undefined,
            vpn: [],
            netdisk: [],
            devices: [],
        }),
        syncOnly: ref([synced(`linux`, `rog`), synced(`windows`, `omen`)]),
        processRows: ref<BackgroundProcessRow[]>([]),
        enabled: ref(ENABLED),
        published: ref([published(`verified`), published(`community`), published(`verified`)]),
        recommendationFor: (tile: string): CapabilityRecommendation | undefined =>
            tile === `linux` ? { entry: `linux`, evidence: `deploy/hosts`, reason: `you deploy to a Linux box`, prefill: {} } : undefined,
    };
    const scope = effectScope();
    scopes.push(scope);
    return { state, pane: scope.run(() => useTilePane(state))! };
};

describe(`the open tile`, () => {
    it(`lists the machines only syncing that belong on it`, () => {
        const { state, pane } = paneOn(LINUX);
        expect(pane.selectedDevices.value.map((device) => device.id)).toEqual([`device:rog`]);

        state.selected.value = undefined;
        expect(pane.selectedDevices.value).toEqual([]);
    });

    it(`states its rows by the roster and names them by what the machine reported`, () => {
        const { state, pane } = paneOn(LINUX);
        const box = state.instances.value[0]!;

        expect(pane.rowState(LINUX, box)).toEqual({ label: `online`, tone: `success`, rank: 3 });
        expect(pane.cardRowFacts(box)).toBe(`Ubuntu 24.04`);
    });

    it(`links a singleton's pending rebuild, and nothing that a row can finish itself`, () => {
        const { pane } = paneOn(WALLET);

        expect(pane.soleRebuildStep(instance(`wallet`, `wallet`, {}, { state: `pending`, detail: `rebuild the sandbox` }))).toBe(true);
        expect(pane.soleRebuildStep(instance(`wallet`, `wallet`, {}))).toBe(false);
        expect(paneOn(LINUX).pane.soleRebuildStep(instance(`box`, `device`, {}, { state: `pending` }))).toBe(false);
    });

    it(`counts what the registry holds and reads the recommendation behind the tile`, () => {
        const { state, pane } = paneOn(LINUX);

        expect([pane.publishedCount.value, pane.verifiedCount.value]).toEqual([3, 2]);
        expect(pane.selectedRecommendation.value?.reason).toBe(`you deploy to a Linux box`);
        state.selected.value = WALLET;
        expect(pane.selectedRecommendation.value).toBeUndefined();
    });

    it(`follows the processes as they start`, () => {
        const { state, pane } = paneOn(LINUX);
        state.instances.value = [instance(`team`, `cli`, { provider: `discord` })];
        expect(pane.cardProcesses.value).toEqual([]);

        const gateway = process(`intentic.chat`, `gateway`);
        state.processRows.value = [gateway];
        expect(pane.cardProcesses.value).toEqual([gateway]);
    });
});
