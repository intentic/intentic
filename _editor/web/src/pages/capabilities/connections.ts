import type { CapabilitySummary } from "@intentic-app/api-contract";
import type { CapabilityKind, CapabilityState, VpnLink } from "@intentic/sandbox-contract";
import type { StatusVariant } from "@intentic/ui";

/* A LIVE CONNECTION, READ THE WAY ITS OWNER READS IT.
 *
 * Two surfaces show the same connections — the Connected slice lists every one in the sandbox, a card lists the
 * ones that came from it — and both read their state through here, so a Reddit account cannot be "needs sign-in"
 * in the inventory and "pending" on its card. That mattered enough to delete a second mapping written for the
 * card rows alone. */

/* A browser capability goes pending on one of TWO different things, and they lead to opposite places: its
 * Chromium is not installed yet (a sandbox rebuild, on another screen) or it is and nobody has signed in (the
 * login window, right on the card). The daemon tells them apart by the word "rebuild" in the detail — see the
 * handler, which is written to keep that word in one and out of the other. Read everywhere that acts on the
 * distinction, so the hint under a card and the hand-off after an add can never disagree about it. */
export const awaitingLogin = (instance: CapabilitySummary): boolean =>
    instance.status.state === `pending` && !String(instance.status.detail ?? ``).includes(`rebuild`);

/* THE ONE UNFINISHED STEP A ROW CANNOT OFFER ITSELF. A pending connection is waiting on one of three things, and
 * two of them — a browser's login, a computer's pairing command — are already a button on the row, so a second
 * link beside the badge saying "Log in →" next to the Log in button was the same click twice.
 *
 * The third has nowhere on the card to go: a rebuild happens on the Sandbox screen. That is the only one that
 * still needs a link, and pointing it at the right place is the whole reason this is a function rather than a
 * `v-if` — a reader sent to /sandbox for a browser that merely needs signing in is a reader who does not come
 * back. */
export const rebuildStep = (kind: CapabilityKind | undefined, instance: CapabilitySummary): boolean =>
    instance.status.state === `pending` && kind !== `host` && !awaitingLogin(instance);

// What identifies a connection to the person who made it, in the order they would say it. `provider`/`platform`
// are deliberately absent — they are the card, which the row already names, so printing them would spend the
// line on "github · github". Secrets never reach here: the daemon strips them from the config it echoes back.
// `email` is an identity row's one fact; `identity` is the born-from note on an account row filed under one.
// `purpose` sits LAST because it is the widest and the least identifying — but for an account under an identity
// it is usually the only other fact there is (a site card pins its URLs, so the row has no host and no url), and
// "what did we open this one for" is the question the owner actually has when they see a name they don't
// recognise. The date it was opened is deliberately not here: it never beats `purpose` for the second slot.
const CONNECTION_FACTS = [`host`, `server`, `url`, `account`, `email`, `identity`, `org`, `guild`, `database`, `user`, `path`, `purpose`] as const;

// Two facts at most. A row is a line, and the third fact is the one that pushes the state badge off the end of it.
export const connectionFacts = (instance: CapabilitySummary): string =>
    CONNECTION_FACTS.map((key) => instance.config[key])
        .filter((value): value is string => typeof value === `string` && value.trim() !== ``)
        .slice(0, 2)
        .join(` · `);

// A connected VPN instance's live facts, compactly: the assigned address and what it routes. Undefined while the
// tunnel is down — the capability row's own status already says that.
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

/* THE STATE IN THE READER'S WORDS, and the order the rows sort in. "active/pending/error/inactive" is the
 * daemon's vocabulary and it is the wrong one here: `pending` is the state of a thing whose setup was never
 * finished, and the reader's question is not what to call it but whether they still have something to do. Rank
 * is the same judgement as the wording — what is unfinished or broken sorts above what is merely working, so a
 * list that mostly works still opens on the part that doesn't. */
const CONNECTION_STATES: Readonly<Record<CapabilityState, ConnectionState>> = {
    error: { label: `error`, tone: `danger`, rank: 0 },
    pending: { label: `needs setup`, tone: `warning`, rank: 1 },
    inactive: { label: `off`, tone: `neutral`, rank: 2 },
    active: { label: `ready`, tone: `success`, rank: 3 },
};

const NEEDS_SIGN_IN: ConnectionState = { label: `needs sign-in`, tone: `warning`, rank: 1 };
const ONLINE: ConnectionState = { label: `online`, tone: `success`, rank: 3 };
const OFFLINE: ConnectionState = { label: `offline`, tone: `neutral`, rank: 2 };

// The kinds whose sign-in is a window the user drives themselves, rather than a credential they paste.
const SIGNS_IN_BY_HAND = new Set<CapabilityKind>([`browser`, `identity`]);

export const signsInByHand = (kind: CapabilityKind | undefined): boolean => kind !== undefined && SIGNS_IN_BY_HAND.has(kind);

/* Two kinds know something truer about themselves than their status field does, and both are the difference
 * between "you have something to do" and "it is simply asleep" — which is exactly what this column is for. A
 * machine's `online` is the roster's answer, which no stored status can carry. */
export const connectionState = (kind: CapabilityKind, instance: CapabilitySummary, hostOnline: boolean | undefined): ConnectionState => {
    if (signsInByHand(kind) && awaitingLogin(instance)) {
        return NEEDS_SIGN_IN;
    }
    if (kind === `host` && instance.status.state === `active`) {
        return hostOnline === true ? ONLINE : OFFLINE;
    }
    return CONNECTION_STATES[instance.status.state];
};
