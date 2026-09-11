import type { CapabilitySummary } from "@intentic/api-contract";
import { capabilityEffects } from "@intentic/capability-catalog";
import type { CapabilityKind, CapabilityState, VpnLink } from "@intentic/sandbox-contract";
import type { StatusVariant } from "@intentic/ui";

// A live connection read the way its owner reads it: both the Connected slice and a card's own list read state
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
    instance.status.state === `pending` && kind !== `host` && !awaitingLogin(instance);

// What identifies a connection, in the order a person would say it. `provider`/`platform` are excluded since the
// row already names the card; secrets never reach here (the daemon strips them). `purpose` sits last, the widest
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
    return [link.address, link.routes.includes(`0.0.0.0/0`) ? `all traffic` : link.routes.join(`, `)]
        .filter((fact) => fact !== undefined && fact !== ``)
        .join(` · `);
};

export interface ConnectionState {
    /** The state in the reader's words, which is not the daemon's word for it. */
    readonly label: string;
    readonly tone: StatusVariant;
    /** Where it sorts: what is unfinished or broken rises above what is merely working. */
    readonly rank: number;
}

// State in the reader's words, since the daemon's active/pending/error/inactive answers the wrong question (whether
// there's still something to do, not what to call it). Rank follows the same judgement: unfinished or broken sorts
// above merely working.
const CONNECTION_STATES: Readonly<Record<CapabilityState, ConnectionState>> = {
    error: { label: `error`, tone: `danger`, rank: 0 },
    pending: { label: `needs setup`, tone: `warning`, rank: 1 },
    inactive: { label: `off`, tone: `neutral`, rank: 2 },
    active: { label: `ready`, tone: `success`, rank: 3 },
};

const NEEDS_SIGN_IN: ConnectionState = { label: `needs sign-in`, tone: `warning`, rank: 1 };
const ONLINE: ConnectionState = { label: `online`, tone: `success`, rank: 3 };
const OFFLINE: ConnectionState = { label: `offline`, tone: `neutral`, rank: 2 };

// What a connected machine's agent may do out there, in the words its own card uses. Read from the effects rather
// than the config so the pairing dialog, wherever it is opened from — the capability card, an offline device's page
// — promises exactly what the card's switches say. The floor, and the fallback for a config too old to describe
// itself, is reading files: no card grants less.
export const machineGrants = (instance: CapabilitySummary | undefined): string => {
    // Asked of a card that hands on no machine — or of nothing at all, while the manifest is still arriving — the
    // answer is the floor rather than a guess, and never the throw an unknown kind would cost (capabilityEffects
    // indexes its kinds).
    if (instance?.kind !== `host`) {
        return `read files`;
    }
    const machine = capabilityEffects({ kind: instance.kind, id: instance.id, config: instance.config }).find(
        (effect) => effect.kind === `machine`,
    );
    return machine === undefined ? `read files` : machine.grants.join(`, `);
};

// The kinds whose sign-in is a window the user drives themselves, rather than a credential they paste.
const SIGNS_IN_BY_HAND = new Set<CapabilityKind>([`browser`, `identity`]);

export const signsInByHand = (kind: CapabilityKind | undefined): boolean => kind !== undefined && SIGNS_IN_BY_HAND.has(kind);

// Two kinds know something truer about themselves than status: a machine's `online` comes from the roster, which no
// stored status can carry.
export const connectionState = (kind: CapabilityKind, instance: CapabilitySummary, hostOnline: boolean | undefined): ConnectionState => {
    if (signsInByHand(kind) && awaitingLogin(instance)) {
        return NEEDS_SIGN_IN;
    }
    if (kind === `host` && instance.status.state === `active`) {
        return hostOnline === true ? ONLINE : OFFLINE;
    }
    return CONNECTION_STATES[instance.status.state];
};
