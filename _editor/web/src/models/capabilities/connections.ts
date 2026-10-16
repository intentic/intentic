import { capabilityEffects } from "@intentic/capability-catalog";
import type { CapabilityKind, CapabilityState, CapabilitySummary } from "@intentic/sandbox-contract/schemas/capabilities";
import { HOST_NATIVE_ENVIRONMENT, type HostSummary } from "@intentic/sandbox-contract/schemas/hosts";
import type { NetdiskLink } from "@intentic/sandbox-contract/schemas/netdisk";
import type { VpnLink } from "@intentic/sandbox-contract/schemas/vpn";
import type { StatusVariant } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { grantList } from "./grants";

// A live connection read the way its owner reads it: both the Connected slice and a tile's own list read state
// through here, so a Reddit account can't be "needs sign-in" in one and "pending" in the other.

// A browser goes pending on one of two things leading to opposite places: Chromium isn't installed (rebuild,
// another screen) or it is and nobody's signed in (login window, right here). The daemon tells them apart by the
// word "rebuild" in the detail.
export const awaitingLogin = (instance: CapabilitySummary): boolean =>
    instance.status.state === `pending` && !String(instance.status.detail ?? ``).includes(`rebuild`);

// The one unfinished step a row can't offer itself: login and pairing are already buttons on the row, so only a
// rebuild (which happens on the Sandbox screen) still needs a link. A function, not a `v-if`, so a signed-in-needed
// reader is never sent to /sandbox by mistake.
export const rebuildStep = (kind: CapabilityKind | undefined, instance: CapabilitySummary): boolean =>
    instance.status.state === `pending` && kind !== `device` && !awaitingLogin(instance);

// What identifies a connection, in the order a person would say it. `provider`/`platform` are excluded since the
// row already names the tile; secrets never reach here (the daemon strips them). `purpose` sits last, the widest
// and least identifying fact, though often the only one an identity-filed account has.
const CONNECTION_FACTS = [`host`, `server`, `url`, `account`, `email`, `identity`, `org`, `guild`, `database`, `user`, `path`, `purpose`] as const;

// Two facts at most. A row is a line, and the third fact is the one that pushes the state badge off the end of it.
export const connectionFacts = (instance: CapabilitySummary): string =>
    CONNECTION_FACTS.map((key) => instance.config[key])
        .filter((value): value is string => typeof value === `string` && value.trim() !== ``)
        .slice(0, 2)
        .join(` · `);

// A connected VPN's live facts: assigned address and routes; undefined while down, since the row's status already
// says that.
export const vpnFacts = (id: string, links: readonly VpnLink[]): string | undefined => {
    const link = links.find((candidate) => candidate.id === id);
    if (link === undefined || link.state !== `connected`) {
        return undefined;
    }
    return [link.address, link.routes.includes(`0.0.0.0/0`) ? t(`capabilities.words.allTraffic`) : link.routes.join(`, `)]
        .filter((fact) => fact !== undefined && fact !== ``)
        .join(` · `);
};

// A mounted disk's live facts: where it is and whether it takes writes, as the kernel has it; undefined while
// unmounted, since the row's status already says that.
export const netdiskFacts = (id: string, links: readonly NetdiskLink[]): string | undefined => {
    const link = links.find((candidate) => candidate.id === id);
    if (link === undefined || link.state !== `mounted`) {
        return undefined;
    }
    return `${link.mountPoint} · ${link.writable === true ? t(`common.netdiskMounts.readWrite`) : t(`common.netdiskMounts.readOnly`)}`;
};

export interface ConnectionState {
    /** The state in the reader's words, which is not the daemon's word for it. */
    readonly label: string;
    readonly tone: StatusVariant;
    /** Where it sorts: what is unfinished or broken rises above what is merely working. */
    readonly rank: number;
    /** What the row says under itself instead of the daemon's own status detail, where the roster knows better. */
    readonly note?: string;
}

// State in the reader's words, since the daemon's active/pending/error/inactive answers the wrong question (whether
// there's still something to do, not what to call it). Rank follows the same judgement: unfinished or broken sorts
// above merely working.
const connectionStates = (): Readonly<Record<CapabilityState, ConnectionState>> => ({
    error: { label: t(`capabilities.connections.stateError`), tone: `danger`, rank: 0 },
    pending: { label: t(`capabilities.connections.needsSetup`), tone: `warning`, rank: 1 },
    inactive: { label: t(`capabilities.connections.stateOff`), tone: `neutral`, rank: 2 },
    active: { label: t(`capabilities.connections.stateReady`), tone: `success`, rank: 3 },
});

// Built when read, so the label follows the language picked after boot.
const needsSignIn = (): ConnectionState => ({ label: t(`capabilities.connections.needsSignIn`), tone: `warning`, rank: 1 });
const online = (): ConnectionState => ({ label: t(`capabilities.connections.online`), tone: `success`, rank: 3 });
const offline = (): ConnectionState => ({ label: t(`capabilities.connections.offline`), tone: `neutral`, rank: 2 });
// A distro by the name WSL knows it by; any other side by its key.
const sideName = (environment: string): string => (environment.startsWith(`wsl:`) ? environment.slice(`wsl:`.length) : environment);

// (2026-10-15) A PC whose Windows side is down while a WSL distro on it still answers is neither offline nor fine: the
// agent can still reach it through the distro, and the sandbox is putting the Windows side back through it. Amber, and
// sorted with what needs a look, since a Windows side that stays down is the owner's to see to.
const partlyConnected = (awake: readonly string[]): ConnectionState => ({
    label: t(`capabilities.connections.partlyConnected`),
    tone: `warning`,
    rank: 1,
    note: t(`capabilities.connections.partlyConnectedNote`, { sides: awake.map(sideName).join(`, `) }, awake.length),
});

/**
 * The sides of a machine other than its own that answer while its own does not: on a PC whose Windows side is down, the
 * WSL distros still connected. Empty while the machine's own side answers, since a distro asleep beside a live Windows is
 * the ordinary state of a PC and no reason to call it degraded.
 */
export const sidesAwakeWithoutIt = (host: Pick<HostSummary, `online` | `environments`> | undefined): string[] =>
    host === undefined || host.online
        ? []
        : host.environments.filter((environment) => environment.key !== HOST_NATIVE_ENVIRONMENT && environment.online).map((environment) => environment.key);

// What a connected machine's agent may do out there, in the words its own tile uses. Read from the effects rather
// than the config so the pairing dialog, wherever it is opened from — the capability tile, an offline device's page
// — promises exactly what the tile's switches say. The floor, and the fallback for a config too old to describe
// itself, is reading files: no tile grants less.
export const machineGrants = (instance: CapabilitySummary | undefined): string => {
    // Asked of a tile that hands on no machine — or of nothing at all, while the manifest is still arriving — the
    // answer is the floor rather than a guess, and never the throw an unknown kind would cost (capabilityEffects
    // indexes its kinds).
    if (instance?.kind !== `device`) {
        return t(`capabilities.connections.readFiles`);
    }
    const machine = capabilityEffects({ kind: instance.kind, id: instance.id, config: instance.config }).find((effect) => effect.kind === `machine`);
    return machine === undefined ? t(`capabilities.connections.readFiles`) : grantList(machine.grants);
};

// What a browser's switches add up to, read off the same effects the tile renders, so dialog and disclosure agree.
export const browserGrants = (instance: CapabilitySummary): string => {
    const browser = capabilityEffects({ kind: instance.kind, id: instance.id, config: instance.config }).find(
        (effect) => effect.kind === `own-browser`,
    );
    const grants = browser === undefined ? [] : browser.grants;
    return grants.length === 0 ? t(`capabilities.connections.nothingUntilSwitch`) : grantList(grants);
};

// What a phone's switches add up to, read off the same effects the tile renders.
export const phoneGrants = (instance: CapabilitySummary): string => {
    const phone = capabilityEffects({ kind: instance.kind, id: instance.id, config: instance.config }).find((effect) => effect.kind === `own-phone`);
    const grants = phone === undefined ? [] : phone.grants;
    return grants.length === 0 ? t(`capabilities.connections.nothingUntilSwitch`) : grantList(grants);
};

// The kinds whose sign-in is a window the user drives themselves, rather than a credential they paste.
const SIGNS_IN_BY_HAND = new Set<CapabilityKind>([`browser`, `identity`]);

export const signsInByHand = (kind: CapabilityKind | undefined): boolean => kind !== undefined && SIGNS_IN_BY_HAND.has(kind);

// Two kinds know something truer about themselves than status: a machine's `online` comes from the roster, which no
// stored status can carry, and so do the other sides of it that answer while its own does not (`awake`, from
// sidesAwakeWithoutIt): the daemon calls such a card pending, "the device is offline", which is half the story.
export const connectionState = (
    kind: CapabilityKind,
    instance: CapabilitySummary,
    hostOnline: boolean | undefined,
    awake: readonly string[] = [],
): ConnectionState => {
    if (signsInByHand(kind) && awaitingLogin(instance)) {
        return needsSignIn();
    }
    const lent = instance.status.state === `active` || instance.status.state === `pending`;
    if (kind === `device` && hostOnline !== true && awake.length > 0 && lent) {
        return partlyConnected(awake);
    }
    if (kind === `device` && instance.status.state === `active`) {
        return hostOnline === true ? online() : offline();
    }
    return connectionStates()[instance.status.state];
};
