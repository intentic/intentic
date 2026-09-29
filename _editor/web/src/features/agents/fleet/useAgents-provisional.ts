import { sandboxShallowRef } from "@intentic/extension-api";
import type { AgentAttention, AgentSummary } from "@intentic/sandbox-contract";
import { otherBoxes } from "../../sandbox/live/fleetAcross";
import type { TabFacts } from "../../chat/tabs/tabFacts";
import type { PendingAction } from "../board/laneDrop";
import { awaitingUser, type EndingByHand, NO_ATTENTION, turnInFlight } from "./agentStatus";
import type { FleetAgent } from "./useAgents-fleet";
import { registry } from "./useAgents-registry";
import { sandboxNow } from "./sandboxClock";
import { onCardAnswered } from "../../chat/session/cardAnswered";

// What this browser's presses draw over a card before the daemon says so, one store keyed per card: a standing a press
// claims, fields a write sends, and the board action still out. Drawn by `overlaid` where the fleet is merged; nothing
// here writes the roster except an answered write, which carries the daemon's own entry.

// What the board can have a card doing before the daemon says so.
export type ClaimKind = `turn` | `stop` | `land` | `discard` | `answer`;

// The two fields every word the daemon says about a card's standing moves (agents-registry summaryOf), and the turn it
// was on, which a Stop is measured against instead (see `moved`).
interface Baseline {
    readonly status: AgentSummary[`status`];
    readonly updatedAt: number;
    readonly startedAt?: number;
}

// One press's layer; its identity is the press, so a settle or timer only ever lifts its own.
interface Layer {
    // Drawn while the daemon's entry still reads `baseline`; `at` is the press on this browser's clock.
    readonly claim?: { readonly kind: ClaimKind; readonly at: number; readonly baseline: Baseline; readonly park?: keyof AgentAttention | undefined };
    readonly patch?: Partial<AgentSummary>;
    readonly action?: PendingAction;
}

// After a press the daemon took: past a frame's usual delay many times over, short enough that a lost one is short.
export const GRACE_MS = 15_000;
// No claim outlives this: every press but a land answers inside the 45s request deadline, and a land yields at once.
export const CEILING_MS = 120_000;

// (sandbox, id) as JSON: agent ids are minted per daemon, so the same id can be two cards from two boxes.
const keyOf = (id: string, at: string | undefined): string => JSON.stringify([at ?? null, id]);

// Sandbox-scoped: a switch re-points the unqualified ids they are keyed by at another daemon's agents.
const layers = sandboxShallowRef<ReadonlyMap<string, readonly Layer[]>>(() => new Map());

const claimOn = (key: string): Layer | undefined => layers.value.get(key)?.find((layer) => layer.claim !== undefined);

// Lays `layer` over the card, a claim replacing any earlier one; the returned lift takes off exactly this layer.
export const hold = (id: string, at: string | undefined, layer: Layer): (() => void) => {
    const key = keyOf(id, at);
    const kept = (layers.value.get(key) ?? []).filter((held) => layer.claim === undefined || held.claim === undefined);
    layers.value = new Map(layers.value).set(key, [...kept, layer]);
    return () => {
        const held = layers.value.get(key);
        if (held?.includes(layer) !== true) {
            return;
        }
        const rest = held.filter((other) => other !== layer);
        const next = new Map(layers.value);
        if (rest.length === 0) {
            next.delete(key);
        } else {
            next.set(key, rest);
        }
        layers.value = next;
    };
};

// The board action out on this card, which withholds a second press until it answers.
export const pendingOn = (id: string, at?: string): PendingAction | undefined =>
    layers.value.get(keyOf(id, at))?.find((layer) => layer.action !== undefined)?.action;

// Draws `patch` over the card until the write answers; the answer is the daemon's entry and replaces the roster's.
export const optimistic = async (id: string, patch: Partial<AgentSummary>, write: () => Promise<AgentSummary>): Promise<void> => {
    const lift = hold(id, undefined, { patch });
    try {
        const summary = await write();
        registry.value = registry.value.map((agent) => (agent.id === id ? summary : agent));
    } finally {
        lift();
    }
};

// The daemon's own entry for a card, never the drawn one: a claim is measured against what the daemon said.
const rosterEntry = (id: string, at: string | undefined): AgentSummary | undefined =>
    at === undefined
        ? registry.value.find((agent) => agent.id === id)
        : otherBoxes.value.find((box) => box.sandbox.id === at)?.agents.find((agent) => agent.id === id);

// Whether the daemon has said something newer than the press knows. A Stop is answered only by the status moving (its
// own `stopping`, or the turn ending some other way) or by another turn: a running turn moves `updatedAt` with every step
// it takes, none of which says anything about the press, and yielding to one drew the card back into Active between
// the press and the daemon's `stopping`.
const moved = (entry: AgentSummary | undefined, kind: ClaimKind, baseline: Baseline): boolean => {
    if (entry === undefined || entry.status !== baseline.status) {
        return true;
    }
    return kind === `stop` ? entry.startedAt !== baseline.startedAt : entry.updatedAt !== baseline.updatedAt;
};

// One press's hold on its card.
export interface Press {
    // `true` hands the card to the roster's next word, `false` takes the claim back now; only the first call counts.
    readonly settle: (taken: boolean) => void;
    // No later press on the card has replaced this one; a press that waits before acting asks, so a later Stop wins.
    readonly stands: () => boolean;
}

// A card the daemon has no entry for has nothing to claim against: its press draws nothing and is never replaced.
const UNCLAIMED: Press = { settle: () => undefined, stands: () => true };

// Draws `kind` over the card now, replacing whatever an earlier press claimed about it; `park` names the ask an answer
// settled.
export const claim = (id: string, at: string | undefined, kind: ClaimKind, park?: keyof AgentAttention): Press => {
    const entry = rosterEntry(id, at);
    if (entry === undefined) {
        return UNCLAIMED;
    }
    const layer: Layer = {
        claim: { kind, at: Date.now(), baseline: { status: entry.status, updatedAt: entry.updatedAt, startedAt: entry.startedAt }, park },
    };
    const lift = hold(id, at, layer);
    const ceiling = setTimeout(lift, CEILING_MS);
    let settled = false;
    const settle = (taken: boolean): void => {
        if (settled) {
            return;
        }
        settled = true;
        const release = (): void => {
            clearTimeout(ceiling);
            lift();
        };
        if (taken) {
            setTimeout(release, GRACE_MS);
        } else {
            release();
        }
    };
    // Lifted by its own timers is still standing; only another press's claim in its place means it was replaced.
    const stands = (): boolean => {
        const current = claimOn(keyOf(id, at));
        return current === undefined || current === layer;
    };
    return { settle, stands };
};

// A press run under a claim: drawn now, settled by the press's own answer. `took` reads an answer that resolved but
// still means no; a throw always does.
export const underClaim = async <T>(
    id: string,
    at: string | undefined,
    kind: ClaimKind,
    run: () => Promise<T>,
    took: (answer: T) => boolean = () => true,
): Promise<T> => {
    const press = claim(id, at, kind);
    try {
        const answer = await run();
        press.settle(took(answer));
        return answer;
    } catch (error) {
        press.settle(false);
        throw error;
    }
};

// A turn this browser knows went, as the daemon publishes one that began (agents-registry summaryOf): nothing parked,
// and no conflict, causes, failure or unfinished check, all of which it derives from the status the turn replaces.
export const asStarted = <T extends FleetAgent>(card: T, startedAt: number): T => ({
    ...card,
    status: `running`,
    startedAt,
    attention: NO_ATTENTION,
    conflictCauses: undefined,
    failure: undefined,
    failureCode: undefined,
    limitResetsAt: undefined,
    limitHeld: undefined,
    limitScheduled: undefined,
    limitMoving: undefined,
    unfinished: undefined,
    activity: undefined,
    unread: false,
});

// A turn a person has ended that the daemon hasn't reported yet, as it will report it (liveStatus): the chosen ending,
// which outranks every park, and nothing parked any more, since ending the turn takes every card it waited on with it.
// Drawn for a board press (a claim) and for one made in a chat (TabFacts.ending) alike.
export const asEnded = <T extends FleetAgent>(card: T, ending: EndingByHand): T => ({
    ...card,
    status: ending,
    attention: NO_ATTENTION,
    unread: false,
});

// A turn a person ended in this browser's chat (TabFacts.ending), drawn as ending from the press, over whatever the
// roster last said, until that chat's stream closes: the other half of useAgents-fleet's `sendingNow`. The chat draws
// its live line from this same card, so the board and the chat cannot disagree about one Stop, and neither waits on the
// daemon to agree.
export const endedHere = <T extends FleetAgent>(card: T, tab: TabFacts | undefined): T =>
    tab?.ending === undefined ? card : asEnded(card, tab.ending);

// A resume the sandbox promised that a later failure in the same turn took back, as this browser's chat saw it
// (TabFacts.resumeWithdrawn). The roster keeps reading `resuming` then, so the sidebar called a chat working for 41
// minutes beside the chat's own "stopped short": drawn instead as the failure the sandbox now holds, as its card will
// read once it stops saying resuming. Only over `resuming`: any later word from the roster is newer than this.
export const withdrawnHere = <T extends FleetAgent>(card: T, tab: TabFacts | undefined): T =>
    tab?.resumeWithdrawn === undefined || card.status !== `resuming` ? card : { ...card, status: `error`, failure: tab.resumeWithdrawn };

// A land between turns: the conflict and failure a settled status carried go with it; only a running turn hides
// `unfinished`, so it stays.
const asLanding = <T extends FleetAgent>(card: T): T => ({
    ...card,
    status: `landing`,
    attention: { ...card.attention, conflict: false },
    conflictCauses: undefined,
    failure: undefined,
    failureCode: undefined,
    limitResetsAt: undefined,
    limitHeld: undefined,
    limitScheduled: undefined,
    limitMoving: undefined,
    unread: false,
});

// A card answered here that the roster still shows parked: the ask it answered gone, and the turn back at work once
// nothing else holds it, as the daemon will say once its un-park reaches this browser. Without it "Permission" and
// "1 needs you" stood for as long as the next roster frame took, sixteen seconds on a phone, and the reader went back
// to check whether the answer took. A park the attention block has no flag for (a payment, a hand-off) only moves
// the status.
const asAnswered = <T extends FleetAgent>(card: T, park: keyof AgentAttention | undefined): T => {
    const attention = park === undefined ? card.attention : { ...card.attention, [park]: false };
    const stillParked = attention.plan || attention.question || attention.permission || attention.capability || attention.credential;
    return { ...card, attention, status: card.status === `awaiting` && !stillParked ? `running` : card.status };
};

// Draws an answer this browser just gave a card in `id`'s chat, until the roster says anything newer about the
// conversation (`moved`) or the grace runs out; the chat's own reply (CardReplies) calls it once the daemon took it.
export const answeredHere = (id: string, park: keyof AgentAttention | undefined): void => {
    claim(id, undefined, `answer`, park).settle(true);
};
onCardAnswered(answeredHere);

// A turn still going that nobody has ended yet: the only standings a Stop is pressed on.
const STOPPABLE: ReadonlySet<FleetAgent[`status`]> = new Set([`running`, `awaiting`, `resuming`]);

// Each claim only over a standing its press is made from, so it never draws a state the daemon could not reach: no
// `landing` over a live turn (a turn's own land reads `running`), no `stopping` over a turn that already ended.
const drawn = <T extends FleetAgent>(card: T, kind: ClaimKind, at: number, park?: keyof AgentAttention): T | undefined => {
    if (kind === `stop`) {
        return STOPPABLE.has(card.status) ? asEnded(card, `stopping`) : card;
    }
    if (kind === `answer`) {
        return awaitingUser(card) ? asAnswered(card, park) : card;
    }
    if (turnInFlight(card) || awaitingUser(card)) {
        return card;
    }
    // The press's instant is this browser's; a started card's clock counts on the sandbox's (sandboxClock.ts).
    return kind === `turn` ? asStarted(card, sandboxNow(at)) : kind === `land` ? asLanding(card) : undefined;
};

// The card under its layers: every write's fields, then the standing claim until the daemon's `entry` moves past it;
// undefined is a card a discard has taken off the board ahead of the roster.
export const overlaid = <T extends FleetAgent>(card: T, entry: AgentSummary, at: string | undefined): T | undefined => {
    const held = layers.value.get(keyOf(entry.id, at));
    if (held === undefined) {
        return card;
    }
    const patched: T = Object.assign({}, card, ...held.map((layer) => layer.patch));
    const standing = held.find((layer) => layer.claim !== undefined)?.claim;
    return standing === undefined || moved(entry, standing.kind, standing.baseline)
        ? patched
        : drawn(patched, standing.kind, standing.at, standing.park);
};
