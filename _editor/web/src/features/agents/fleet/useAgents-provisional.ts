import type { AgentSummary } from "@intentic/sandbox-contract";
import { shallowRef } from "vue";
import { otherBoxes } from "../../sandbox/live/fleetAcross";
import { awaitingUser, NO_ATTENTION, turnInFlight } from "./agentStatus";
import type { FleetAgent } from "./useAgents-fleet";
import { registry } from "./useAgents-registry";

// What a press in this browser says a card is, drawn from the press until the daemon's own word on the card moves past
// what it said then (the web README's "A board press lands in the frame it was made in"). Between the registry, which a
// claim is measured against, and the fleet merge, which draws it; nothing here writes the roster.

// What the board can have a card doing before the daemon says so.
export type ClaimKind = `turn` | `stop` | `land` | `discard`;

// The two fields every word the daemon says about a card's standing moves (agents-registry summaryOf).
interface Baseline {
    readonly status: AgentSummary[`status`];
    readonly updatedAt: number;
}

interface Claim {
    readonly kind: ClaimKind;
    // The press, on this browser's clock; a turn's elapsed readout counts from it until the roster's own start lands.
    readonly at: number;
    readonly baseline: Baseline;
    // Identity of the press, so a settle or timer only ever retires its own claim and never a later press's.
    readonly token: object;
}

// After a press the daemon took: past a frame's usual delay many times over, short enough that a lost one is short.
export const GRACE_MS = 15_000;
// No claim outlives this: every press but a land answers inside the 45s request deadline, and a land yields at once.
export const CEILING_MS = 120_000;

// Keyed by (sandbox, id) as JSON, like the board's in-flight map: agent ids are minted per daemon, so the same id can
// be two cards from two boxes.
const keyOf = (id: string, at: string | undefined): string => JSON.stringify([at ?? null, id]);

const claims = shallowRef<ReadonlyMap<string, Claim>>(new Map());

// The daemon's own entry for a card, never the drawn one: a claim is measured against what the daemon said.
const rosterEntry = (id: string, at: string | undefined): AgentSummary | undefined =>
    at === undefined
        ? registry.value.find((agent) => agent.id === id)
        : otherBoxes.value.find((box) => box.sandbox.id === at)?.agents.find((agent) => agent.id === id);

const moved = (entry: AgentSummary | undefined, baseline: Baseline): boolean =>
    entry === undefined || entry.status !== baseline.status || entry.updatedAt !== baseline.updatedAt;

const release = (key: string, token: object): void => {
    if (claims.value.get(key)?.token !== token) {
        return;
    }
    const next = new Map(claims.value);
    next.delete(key);
    claims.value = next;
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

// Draws `kind` over the card now, replacing whatever an earlier press claimed about it.
export const claim = (id: string, at: string | undefined, kind: ClaimKind): Press => {
    const entry = rosterEntry(id, at);
    if (entry === undefined) {
        return UNCLAIMED;
    }
    const key = keyOf(id, at);
    const token = {};
    claims.value = new Map(claims.value).set(key, { kind, at: Date.now(), baseline: { status: entry.status, updatedAt: entry.updatedAt }, token });
    const ceiling = setTimeout(() => release(key, token), CEILING_MS);
    let settled = false;
    const settle = (taken: boolean): void => {
        if (settled) {
            return;
        }
        settled = true;
        if (!taken) {
            clearTimeout(ceiling);
            release(key, token);
            return;
        }
        setTimeout(() => {
            clearTimeout(ceiling);
            release(key, token);
        }, GRACE_MS);
    };
    // Released by its own timers is still standing; only another press's token in its place means it was replaced.
    const stands = (): boolean => {
        const current = claims.value.get(key);
        return current === undefined || current.token === token;
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

// A Stop the daemon hasn't reported yet: `stopping`, which a chosen ending outranks every park with (liveStatus).
const asStopping = <T extends FleetAgent>(card: T): T => ({ ...card, status: `stopping`, unread: false });

// A land between turns: the lease reads `landing`, and the conflict and failure a settled status carried go with the
// status they were derived from; `unfinished` survives, since only a running turn hides it.
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

// A turn still going that nobody has ended yet: the only standings a Stop is pressed on.
const STOPPABLE: ReadonlySet<FleetAgent[`status`]> = new Set([`running`, `awaiting`, `resuming`]);

// Each claim only over a standing its press is made from, so it never draws a state the daemon could not reach: no
// `landing` over a live turn (a turn's own land reads `running`), no `stopping` over a turn that already ended.
const drawn = <T extends FleetAgent>(card: T, held: Claim): T | undefined => {
    if (held.kind === `stop`) {
        return STOPPABLE.has(card.status) ? asStopping(card) : card;
    }
    if (turnInFlight(card) || awaitingUser(card)) {
        return card;
    }
    return held.kind === `turn` ? asStarted(card, held.at) : held.kind === `land` ? asLanding(card) : undefined;
};

// The card as its standing claim draws it, or as built once the daemon's `entry` for it has moved past the claim;
// undefined is a card a discard has taken off the board ahead of the roster.
export const claimedCard = <T extends FleetAgent>(card: T, entry: AgentSummary, at: string | undefined): T | undefined => {
    const held = claims.value.get(keyOf(entry.id, at));
    if (held === undefined || moved(entry, held.baseline)) {
        return card;
    }
    return drawn(card, held);
};

// Drops every claim: a sandbox switch re-points the unqualified ids they are keyed by at another daemon's agents.
export const forgetClaims = (): void => {
    claims.value = new Map();
};
