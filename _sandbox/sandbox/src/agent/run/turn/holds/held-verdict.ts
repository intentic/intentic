import { type AgentProvider, withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { ResumeRouting } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { Services } from "../../../../composition.js";
import type { HeldRecord } from "../../../../conversations/actor/conversation-state.js";
import { type HeldReading, heldReopensAt, type LimitBooking, limitBooking, reopenedBy, sendableAt } from "../../../../conversations/actor/limit-booking.js";
import { accountsJudge, type AllowanceWall, fleetCapacityOf } from "../../../../usage/serviceability/serviceability.js";
import { knownReopensAt } from "../../../models/limit-reset.js";
import { type LimitMoveDeps, moveDestinationOf } from "../../../models/sibling-account.js";
import { childRerunHorizonMs } from "../../../subagents/child-records.js";
import { childRerunAt } from "../../frames/classify-failure.js";
import { breakPolicyFor } from "../break-policy.js";
import { opt } from "../../../../opt.js";
import { wallAhead, type WallDeps } from "./allowance-gate.js";
import type { HeldOf } from "./held-turn.js";

/* WHEN A SPENT ALLOWANCE'S HELD TURN GOES, AND WHERE: DERIVED FROM WHAT THE HOLD MEANT AND WHAT THE RECORDS SAY NOW. The
   hold keeps only its intent: the provider, model and account it was refused on, the owner's booked move (and whether
   its session carries), a person's pick, and the refusal's own instant, which is evidence of when that account reopens
   rather than a booking. Every pass reads the records against it (readHeld): the allowance wall in front of the route it
   would take (allowance-gate.ts wallAhead, the gate's own reading), whether the provider's accounts can serve its model
   at all (fleetCapacityOf), and, for a booked move, an account with room (placement.ts, through sibling-account.ts
   moveDestinationOf). The rule over that reading is limit-booking.ts limitBooking, which the card's `next`, its reset,
   the admission's shut window and the sleep wake apply too, to the reading the pass leaves on the hold (`held-read`, its
   only writer), so none of them can say otherwise than the pass does.

   So: a hold whose account reopens before the instant it was refused with goes at the pass that reads it open; a booked
   move whose account has been spent since goes onto another with room rather than waiting behind it, and waits on its
   own account where none has; a person's pick goes at the picked account's reopen as the records read it then. The
   policies stay as they were: a reset's grace (sendableAt), a child's spread past a reset (childRerunAt) and its horizon
   (childRerunHorizonMs), the conversation's answer to the limit, and a reset already past at the refusal never fired at.

   2026-11-19: before this the hold carried copies of these answers and paced passes reconciled them (held-standing.ts
   re-timed an untimed hold and woke a timed one once a minute, limit-due.ts wrote the wall onto it every beat, a pick
   froze its account's reopen, and a booked move waited behind its spent destination). Keeping the copies and reconciling
   one more path was rejected: each reconciliation ran after the fact, and the card said what the pass would no longer do
   until the next one did. */

/** What a held turn's reading reads: the verdicts, the planner and the reach where given, the settings, the actors. */
export type HeldReadDeps = WallDeps & LimitMoveDeps & Pick<Services, "agents" | "conversations" | "sandboxSettings">;

type LimitHold = HeldOf<"limit"> & Pick<HeldRecord, "recordedAt" | "reading">;

// The hold's provider, model and the account it goes on without a move or a pick: the one it was refused on, else the
// conversation's own (as the gate reads it, allowance-gate.ts spentUntil).
interface Route {
    readonly provider: AgentProvider;
    readonly model: string | undefined;
    readonly account: string | undefined;
}

const routeOf = (services: Pick<Services, "agents">, conversationId: string, held: LimitHold): Route => ({
    provider: withRuntimeDefaults(held.input).agent,
    model: held.input.model === undefined || held.input.model === "" ? undefined : held.input.model,
    account: held.input.account ?? services.agents.entry(conversationId)?.profile.account,
});

// A route found open: due from the instant it was first found so, which the reading keeps while it stays open. A child
// goes its spread past it (childRerunAt), so siblings refused together do not all go in one second.
const openRoute = (since: number, spreadFor: string | undefined): HeldReading => {
    if (spreadFor === undefined) {
        return { at: since, reopensAt: reopenedBy(since), openSince: since };
    }
    const reopensAt = childRerunAt(reopenedBy(since), spreadFor);
    return { at: sendableAt(reopensAt), reopensAt, openSince: since };
};

// A route behind an instant (epoch s), pushed later by the wall in front of it, never brought earlier by it.
const timedRoute = (reopensAt: number, wall: AllowanceWall | undefined): HeldReading => {
    const at = Math.max(reopensAt, wall?.reopensAt ?? 0);
    return { at: sendableAt(at), reopensAt: at };
};

/* A RESET'S GRACE OUTLIVES THE WALL THAT NAMED IT. The records stop calling an account spent at its reset, while the
   sandbox's own sends wait out the grace after it (limit-booking.ts RESET_GRACE_MS): read on its own in that minute, the
   wall is gone and the hold would go into a provider whose window has not yet turned over. A reading inside the grace
   of the reopen the last one read keeps that instant, unless the records now put it later still. A hold no pass had
   read before the reset (one restored inside that minute) has no earlier reading to keep, and goes by the records. */
const withGrace = (live: HeldReading, was: HeldReading | undefined, now: number): HeldReading => {
    if (was?.at === undefined || was.reopensAt === undefined || was.reopensAt * 1000 > now || was.at <= now) {
        return live;
    }
    return live.at === undefined || live.at >= was.at ? live : { at: was.at, reopensAt: was.reopensAt };
};

/**
 * The route a person picked: the picked account's wall as the records read it now. Open, it goes now; spent with a
 * reopen named, at the grace after it; spent with none named, only a press sends it. Also what switch-account.ts reads
 * as it re-points the hold, so the pick and the pass judge the account by one reading. `was` is the reading the hold
 * already carries for this same pick, whose `openSince` it keeps.
 */
export const pickedReading = async (
    services: WallDeps,
    on: { readonly provider: AgentProvider; readonly account: string; readonly model: string | undefined },
    was: HeldReading | undefined,
    now: number,
): Promise<HeldReading> => {
    const wall = await wallAhead(services, on, now);
    if (wall === undefined) {
        return withGrace(openRoute(was?.openSince ?? now, undefined), was, now);
    }
    return wall.reopensAt === undefined ? {} : timedRoute(wall.reopensAt, wall);
};

// Whether the provider's accounts together can serve the model now (plan-pools.ts fleetCapacity, the rule the picker
// reads). A verdict that cannot be read keeps the hold where the refusal put it.
const servable = async (services: HeldReadDeps, route: Route, now: number): Promise<boolean> => {
    try {
        return (await fleetCapacityOf(services, route.provider, route.model === undefined ? undefined : { id: route.model }, now)).kind === "serving";
    } catch (error) {
        services.logger.warn({ err: error, provider: route.provider }, "resume pass: the accounts could not be judged for a held turn's model, it keeps its reopen");
        return false;
    }
};

// Where a child goes past a reset (its id, for childRerunAt), with its horizon; neither for a conversation nobody spawned.
const childTerms = async (services: HeldReadDeps, conversationId: string): Promise<{ readonly horizon?: number; readonly spreadFor?: string }> => {
    const horizon = childRerunHorizonMs(services.conversations, conversationId, await services.sandboxSettings.get());
    return horizon === undefined ? {} : { horizon, spreadFor: conversationId };
};

/* A HOLD REFUSED WITH NO INSTANT is timed by what the records know of its pool's reopen (limit-reset.ts knownReopensAt):
   a reading taken since, or a sibling on the same model told when. Its "Send again" then has an appointment to keep.
   Not a hold the refusal left untimed on purpose (a child's reset past its horizon, stated on the ending and kept off
   the hold), nor a reset past the child's horizon now. 2026-10-19: three Codex conversations answered "Send again"; the
   two refused with a bare 429 had no instant, so nothing would ever send them. */
const untimedRoute = async (services: HeldReadDeps, conversationId: string, held: LimitHold, route: Route, wall: AllowanceWall | undefined, now: number): Promise<HeldReading> =>
    withGrace(await learnedRoute(services, conversationId, route, wall, now), held.reading, now);

const learnedRoute = async (services: HeldReadDeps, conversationId: string, route: Route, wall: AllowanceWall | undefined, now: number): Promise<HeldReading> => {
    const ending = services.agents.entry(conversationId)?.ending;
    if (ending?.kind !== "limited" || ending.resetsAt !== undefined) {
        return {};
    }
    const known = await knownReopensAt({ services, provider: route.provider, model: route.model, account: route.account, now });
    if (known === undefined || known * 1000 <= now) {
        return {};
    }
    const child = await childTerms(services, conversationId);
    if (child.horizon !== undefined && known * 1000 - now > child.horizon) {
        return {};
    }
    return timedRoute(child.spreadFor === undefined ? known : childRerunAt(known, child.spreadFor), wall);
};

/* A TIMED HOLD GOES ONCE ITS ACCOUNT CAN SERVE IT, NOT ONLY AT THE INSTANT IT WAS REFUSED WITH (2026-11-08). That instant
   is the refusal's word, and a conversation refused on Google's Gemini pool waited for a reopen six days out while the
   picker already showed its model servable. Where the provider's accounts can serve the model and the account it goes
   on stands behind no wall, it goes at the pass that reads so; until then at the later of its instant and that wall. A
   reset already past when it was refused is never fired at: it would only loop. */
const ownRoute = async (services: HeldReadDeps, conversationId: string, held: LimitHold, now: number): Promise<HeldReading> => {
    const route = routeOf(services, conversationId, held);
    const wall = await wallAhead(services, route, now);
    if (held.reopensAt === undefined) {
        return untimedRoute(services, conversationId, held, route, wall, now);
    }
    const refused = heldReopensAt(held);
    if (refused === undefined) {
        return { reopensAt: held.reopensAt };
    }
    if (refused > now && wall === undefined && (await servable(services, route, now))) {
        return openRoute(held.reading?.openSince ?? now, (await childTerms(services, conversationId)).spreadFor);
    }
    return withGrace(timedRoute(held.reopensAt, wall), held.reading, now);
};

// Where a booked move goes now: the account it was booked onto while that one can serve, else another with room among
// those the conversation's people may use; undefined where none has, and the hold waits on its own route. 2026-11-19: a
// move's account was judged once at the failure, and a restart or a slow pass that found it spent since waited behind it.
const moveTo = async (services: HeldReadDeps, conversationId: string, held: LimitHold, now: number): Promise<string | undefined> => {
    const booked = held.move?.account;
    if (booked === undefined) {
        return undefined;
    }
    const route = routeOf(services, conversationId, held);
    return (await bookedServes(services, route, booked, now))
        ? booked
        : moveDestinationOf(services, { conversationId, provider: route.provider, model: route.model, refused: route.account });
};

// Whether the account a move was booked onto may still take it: anything but spent or blocked, as the records read it.
// A verdict that cannot be read leaves the move where it was booked.
const bookedServes = async (services: HeldReadDeps, route: Route, account: string, now: number): Promise<boolean> => {
    try {
        const judge = await accountsJudge(services, route.provider, now);
        const state = judge.accounts(route.model === undefined ? undefined : { id: route.model }).find((row) => row.id === account)?.state;
        return state?.kind !== "spent" && state?.kind !== "blocked";
    } catch (error) {
        services.logger.warn({ err: error, provider: route.provider, account }, "resume pass: a booked move's account could not be judged, it goes there as booked");
        return true;
    }
};

/**
 * What the records say now about where an unfired spent-allowance hold can go (limit-booking.ts HeldReading): its route
 * (a person's pick, else the account it was refused on) and, for a booked move, the account it would move onto. Read
 * whatever the conversation's answer, so the answer can be applied to it wherever it is read, synchronously.
 */
const readHeld = async (services: HeldReadDeps, conversationId: string, held: LimitHold, now: number): Promise<HeldReading> => {
    const [route, moving] = await Promise.all([
        held.onto === undefined
            ? ownRoute(services, conversationId, held, now)
            : pickedReading(services, { ...routeOf(services, conversationId, held), account: held.onto.account }, held.reading, now),
        moveTo(services, conversationId, held, now),
    ]);
    return { ...route, ...opt("moveTo", moving) };
};

/** A held turn's verdict: the hold as it stands with the reading on it, when it goes by itself, and where. */
export interface HeldVerdict {
    // The record a fire names (conversation-decide.ts onHeldFired): the one the reading was put on.
    readonly held: HeldRecord;
    // When it goes by itself; absent where only a press sends it.
    readonly booking?: LimitBooking;
    // Where: a move's account, else a person's pick; absent goes where it was refused.
    readonly routing?: ResumeRouting;
}

// Where a booked hold goes: the account it moves onto while the answer is still to move, else a person's pick, else its own.
const routingOf = (held: HeldRecord, booking: LimitBooking): ResumeRouting | undefined => {
    const { agent, harness } = withRuntimeDefaults(held.input);
    if (booking.moving !== undefined && held.move !== undefined) {
        return { agent, harness, account: booking.moving, carry: held.move.carry };
    }
    return held.onto === undefined ? undefined : { agent, harness, account: held.onto.account, ...opt("carry", held.onto.carry ? true : undefined) };
};

/**
 * Whether an unfired spent-allowance hold goes now, when, and where: the records read against its intent (readHeld),
 * put on the hold for the card and every other reader that cannot wait for a reading, and judged by the one rule
 * (limit-booking.ts limitBooking) under the conversation's answer to the limit. Undefined for any other hold, a fired
 * one, or one re-pointed, replaced or fired while it was read: the next pass judges that as it stands.
 */
export const heldVerdict = async (services: HeldReadDeps, conversationId: string, held: HeldRecord, now: number): Promise<HeldVerdict | undefined> => {
    if (held.reason !== "limit" || held.fired) {
        return undefined;
    }
    const [policy, reading] = await Promise.all([breakPolicyFor(services, conversationId, "limit"), readHeld(services, conversationId, held, now)]);
    services.conversations.send(conversationId, { kind: "held-read", judged: held, reading }, now);
    const current = services.conversations.state(conversationId)?.resume.held;
    if (current === undefined || (current !== held && current.reading !== reading)) {
        return undefined;
    }
    const booking = limitBooking(current, policy);
    return { held: current, ...opt("booking", booking), ...opt("routing", booking === undefined ? undefined : routingOf(current, booking)) };
};
