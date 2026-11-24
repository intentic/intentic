import { t } from "@intentic/ui/i18n";
import type { CapabilityKind, CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Device } from "@intentic/sandbox-contract/schemas/devices";
import type { HostSummary } from "@intentic/sandbox-contract/schemas/hosts";
import type { NetdiskLink } from "@intentic/sandbox-contract/schemas/netdisk";
import type { PhoneSummary } from "@intentic/sandbox-contract/schemas/phone";
import type { VpnLink } from "@intentic/sandbox-contract/schemas/vpn";
import type { WebExtSummary } from "@intentic/sandbox-contract/schemas/webext";
import { connectionFacts, netdiskFacts, phoneSystem, vpnFacts } from "../../../models/capabilities/connections";
import { sameMachineNote } from "./deviceConnections";

// What a connection's facts line says where a live source knows more than its stored config: a machine's OS, a
// browser's sites, a phone's release, a tunnel's address. Each kind that has one is a row of ROW_FACTS below; every
// other kind's line is its stored config's (connectionFacts). Kept out of kindSlots.ts on purpose: the Sandbox map reads
// these lines through connectionRows.ts, and the slot registry imports every pairing dialog and form part.

// The live answers no stored config holds: the machine and browser rosters, tunnels and disks as the kernel has them,
// and the daemon's one device registry.
export interface ConnectionSources {
    readonly host: (id: string) => HostSummary | undefined;
    readonly browser: (id: string) => WebExtSummary | undefined;
    readonly phone: (id: string) => PhoneSummary | undefined;
    readonly vpn: readonly VpnLink[];
    readonly netdisk: readonly NetdiskLink[];
    readonly devices: readonly Device[];
}

// A phone names itself and its Android release (a watch, its Wear OS), and says when it cannot be woken yet: asleep is its usual state, so
// "can't be woken" is the one thing worth the owner's attention.
export const phoneFacts = (instance: CapabilitySummary, sources: ConnectionSources): string => {
    const phone = sources.phone(instance.id);
    if (phone?.facts === undefined) {
        return connectionFacts(instance);
    }
    const wake =
        phone.wake === `ready`
            ? ``
            : phone.wake === `register`
              ? t(`capabilities.connections.wakeNotSetUp`)
              : t(`capabilities.connections.answersWhileAppOpen`);
    return [phoneSystem(phone.facts), phone.facts.paused ? t(`capabilities.connections.pausedOnPhone`) : ``, wake]
        .filter((fact) => fact !== ``)
        .join(` · `);
};

// A device's facts line: its OS, and the other doors onto the same PC when it has any, so two ids that are one
// computer read as one on this screen too.
export const hostFacts = (instance: CapabilitySummary, sources: ConnectionSources): string =>
    [sources.host(instance.id)?.facts?.os ?? connectionFacts(instance), sameMachineNote(sources.devices, instance.id)]
        .filter((fact): fact is string => fact !== undefined && fact !== ``)
        .join(` · `);

// A browser names itself and how many sites it may work on; no stored config can answer either.
const webextFacts = (instance: CapabilitySummary, sources: ConnectionSources): string => {
    const facts = sources.browser(instance.id)?.facts;
    return facts === undefined
        ? connectionFacts(instance)
        : t(`capabilities.connectionRows.sitesAllowed`, { browser: facts.browser, count: facts.grants.length }, facts.grants.length);
};

// A tunnel's live address, and a disk's mount point and whether it takes writes, before what the card stores.
const vpnRowFacts = (instance: CapabilitySummary, sources: ConnectionSources): string =>
    vpnFacts(instance.id, sources.vpn) ?? connectionFacts(instance);
const netdiskRowFacts = (instance: CapabilitySummary, sources: ConnectionSources): string =>
    netdiskFacts(instance.id, sources.netdisk) ?? connectionFacts(instance);

type RowFacts = (instance: CapabilitySummary, sources: ConnectionSources) => string;

// The kinds whose facts line a live source knows more of than their stored config, in CapabilityKindSchema's order.
export const ROW_FACTS: ReadonlyMap<CapabilityKind, RowFacts> = new Map<CapabilityKind, RowFacts>([
    [`vpn`, vpnRowFacts],
    [`netdisk`, netdiskRowFacts],
    [`device`, hostFacts],
    [`webext`, webextFacts],
    [`phone`, phoneFacts],
]);

// A row's facts line, on the tile's own list and in the Connected slice alike: the kind's own live facts where it has
// them, else what its stored config says.
export const rowFactsOf = (kind: CapabilityKind | undefined, instance: CapabilitySummary, sources: ConnectionSources): string => {
    const facts = kind === undefined ? undefined : ROW_FACTS.get(kind);
    return facts?.(instance, sources) ?? connectionFacts(instance);
};
