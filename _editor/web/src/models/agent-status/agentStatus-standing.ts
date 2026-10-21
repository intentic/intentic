import type { AgentStanding } from "@intentic/sandbox-contract/models/agent-standing";
import type { AgentNext } from "@intentic/sandbox-contract/schemas/agent-next";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";

// Every projection of a fleet agent's state (lane, attention label, drill-in verb, glyphs) lives in the contract
// (@intentic/sandbox-contract/models/agent-standing.ts) since 2026-10-16, so the daemon counts what needs the person by the
// same rules (its `agents.attention`, the desktop app's status bar). Re-exported here, where every surface of the editor
// has always imported it; what stays below is the editor's own: a card's standing copied for a tab or another window,
// and the auto-land default.
export { goesBySelf } from "@intentic/sandbox-contract/schemas/agent-next";
export {
    limited,
    memoryHeld,
    limitClosed,
    conflictIsYours,
    watching,
    promptHeldJob,
    heldByPrompt,
    unregistered,
    turnInFlight,
    endingOf,
    endingByHand,
    turnWorking,
    writingNow,
    landBroken,
    blocked,
    awaitingUser,
    onlyOwnerCanAnswer,
    heardByParent,
} from "@intentic/sandbox-contract/models/agent-standing";
export type { ClientAgentStatus, AgentStanding, EndingByHand } from "@intentic/sandbox-contract/models/agent-standing";

// A card's standing on its own, carried where a whole card can't go (a chat tab, a summons to another window):
// every field `laneOf` reads and nothing else, with absent ones left out rather than spelled as undefined, since
// this is persisted and posted between windows.
export const standingFrom = (agent: AgentStanding): AgentStanding => {
    const copied = standingCopy(agent);
    const standing = agent.landFailure === undefined ? copied : { ...copied, landFailure: agent.landFailure };
    return agent.next === undefined ? standing : { ...standing, next: agent.next };
};
const standingCopy = (agent: AgentStanding): AgentStanding => {
    const copy: AgentStanding = {
        status: agent.status,
        // Copied, not referenced: this outlives the roster entry it was read from, in a tab and in storage.
        attention: { ...agent.attention },
        ...(agent.watches !== undefined ? { watches: agent.watches } : {}),
        ...(agent.awaitingWake !== undefined ? { awaitingWake: agent.awaitingWake } : {}),
        ...(agent.conflictCauses !== undefined ? { conflictCauses: agent.conflictCauses } : {}),
        ...(agent.failureCode !== undefined ? { failureCode: agent.failureCode } : {}),
        ...(agent.limitResetsAt !== undefined ? { limitResetsAt: agent.limitResetsAt } : {}),
        ...(agent.limitHeld !== undefined ? { limitHeld: agent.limitHeld } : {}),
    };
    // The jobs go with it: a job at a prompt holds the card's lane (heldByPrompt).
    return agent.jobs === undefined ? copy : { ...copy, jobs: agent.jobs };
};

/* A CARD FROM A SANDBOX OLDER THAN `next`, READ AS ONE THAT HAS IT. Every lane, corner and Clear reads only `next`
   (agent-next.ts), which a daemon before 1.343.0 never sends: it says the same things in the fields `next` replaced, a
   spent allowance's held turn booked to go again (`limitScheduled`, at `limitNextAt` in epoch seconds, moving to
   `limitMoving`) and the bookings in its queue. The hosted editor meets such a daemon for as long as its sandbox stays
   off the release that dropped them, which a Breaking-Note keeps it from taking by itself, and read bare its booked
   resend sat in Attention as a dead end and its booked messages counted as Clear's (2026-10-21). So a card without
   `next` gets it here, by the rules this editor read those fields by before (075cfa8637~1), where the roster comes in. A
   memory hold's send is not among them: an older card says nothing of the answer to the memory wall. */
type OlderCard = Pick<AgentSummary, "status" | "failureCode" | "limitResetsAt" | "limitScheduled" | "limitMoving" | "limitNextAt" | "queue" | "next">;

// A held turn's booked re-run: at the pass's own instant, else the reopen it was booked for; a move goes on the next pass.
const olderRerun = (card: OlderCard): AgentNext | undefined => {
    if (card.status !== `error` || card.failureCode !== `rate_limit` || card.limitScheduled !== true) {
        return undefined;
    }
    if (card.limitMoving !== undefined) {
        return { kind: `rerun`, at: (card.limitNextAt ?? 0) * 1_000, onto: card.limitMoving };
    }
    return { kind: `rerun`, at: (card.limitNextAt ?? card.limitResetsAt ?? 0) * 1_000 };
};

// The messages booked for later: the queue's own soonest booking while it reads `scheduled` (every message in it, on a
// sandbox older than per-message bookings), else the earliest message's time, else the first message waiting on a land.
const olderBooking = (queue: OlderCard[`queue`]): AgentNext | undefined => {
    if (queue === undefined) {
        return undefined;
    }
    if (queue.paused === `scheduled`) {
        const count = Math.max(1, queue.items.length);
        if (queue.after !== undefined) {
            return { kind: `land`, after: queue.after, count };
        }
        if (queue.until !== undefined) {
            return { kind: `send`, at: queue.until, count };
        }
    }
    const booked = queue.items.filter((item) => item.until !== undefined || item.after !== undefined);
    const count = Math.max(1, booked.length);
    const instants = booked.flatMap((item) => (item.until === undefined ? [] : [item.until]));
    if (instants.length > 0) {
        return { kind: `send`, at: Math.min(...instants), count };
    }
    const after = booked.find((item) => item.after !== undefined)?.after;
    return after === undefined ? undefined : { kind: `land`, after, count };
};

/** The card with the `next` an older sandbox's fields say, the held turn first as the daemon reads it; as it came otherwise. */
export const withNext = <T extends OlderCard>(card: T): T => {
    if (card.next !== undefined) {
        return card;
    }
    const next = olderRerun(card) ?? olderBooking(card.queue);
    return next === undefined ? card : { ...card, next };
};

// Whether a clean turn's work lands by itself, folding the agent's own override, the sandbox default, and the
// schema default (off) into one answer every surface must agree on. Takes plain values rather than reaching for
// stores; this module is a leaf.
export const effectiveAutoLand = (agent: { readonly autoLand?: boolean } | undefined, sandboxDefault: boolean | undefined): boolean =>
    agent?.autoLand ?? sandboxDefault ?? false;
