import { type AgentProvider, withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../../../composition.js";
import type { TurnInput } from "../../../../seams/turn-starter.js";
import { opt } from "../../../../opt.js";
import { type AllowanceWall, allowanceWall, fleetCapacityOf, type ServiceabilityDeps } from "../../../../usage/serviceability/serviceability.js";
import { reopenOfRouted } from "../booking-ask.js";
import { sendableAt } from "../../../../conversations/actor/limit-booking.js";

/* WHAT GOES OUT WITH NOBODY PRESSING ANYTHING NEVER GOES INTO AN ALLOWANCE THE RECORDS CALL SPENT. A person's words the
   sandbox releases by itself (a memory hold once room comes back, a booking whose time came) used to go straight to the
   provider whatever the records said, to be refused within seconds; a refusal that came after the turn began then turned
   those words into a held turn, re-run hours later behind a note of the sandbox's own instead of as they were written
   (2026-10-17). spent-door.ts holds a turn the sandbox starts itself the same way; this is the other half, for a person's
   words the sandbox lets go: they are booked for the reopen instead, where every window draws them as scheduled, and go
   then. A person's own press still always goes: they may know what the records do not. */

// The request a release would make, as far as who pays for it: the provider, the account, the model.
type Routed = Pick<TurnInput, "agent" | "harness" | "account" | "model"> & { readonly conversationId: string };

// What the wall is read from: the verdicts, and the log a verdict that cannot be read is said in.
export type WallDeps = ServiceabilityDeps & Pick<Services, "logger">;

/**
 * The allowance wall in front of `account` for one model (serviceability.ts allowanceWall), or, naming no account, in
 * front of the provider's every account together (fleetCapacityOf: a wall only once every one is spent or blocked):
 * undefined while it can serve, `{}` where it is spent with no reopening named. The one reading of it that the gate,
 * every rung of the resume pass and a held turn's verdict (held-verdict.ts) share. A verdict that cannot be read puts
 * nothing in the way: the turn goes, as it did before any of them read one, and the provider answers.
 */
export const wallAhead = async (
    services: WallDeps,
    on: { readonly provider: AgentProvider; readonly account: string | undefined; readonly model: string | undefined },
    now: number,
): Promise<AllowanceWall | undefined> => {
    const { provider, account } = on;
    const model = on.model === undefined || on.model === "" ? undefined : { id: on.model };
    try {
        if (account !== undefined) {
            return await allowanceWall(services, provider, account, model, now);
        }
        const fleet = await fleetCapacityOf(services, provider, model, now);
        return fleet.kind === "spent" ? opt("reopensAt", fleet.reopensAt) : undefined;
    } catch (error) {
        services.logger.warn({ err: error, provider, account }, "allowance gate: could not read the verdict, so nothing is held back by it");
        return undefined;
    }
};

/**
 * When the account these words would go on lets them through again, in milliseconds (its reopening and the grace after
 * it, limit-booking.ts RESET_GRACE_MS), where the records call it spent with that still ahead; undefined to let them go
 * now (room, no reading, a spent reading naming no reopening, or a reopening already past). The account is the one the
 * words name, else the conversation's own; with neither, every account of the provider must read spent, as
 * spent-door.ts reads it.
 */
export const spentUntil = async (services: WallDeps & Pick<Services, "agents">, turn: Routed, now: number = Date.now()): Promise<number | undefined> => {
    const { agent } = withRuntimeDefaults(turn);
    const account = turn.account ?? services.agents.entry(turn.conversationId)?.profile.account;
    const reopensAt = (await wallAhead(services, { provider: agent, account, model: turn.model }, now))?.reopensAt;
    const until = reopensAt === undefined ? undefined : sendableAt(reopensAt);
    return until === undefined || until <= now ? undefined : until;
};

/**
 * Books the waiting words `ids` names for the reopen of the account they would go on (the newest person's among them,
 * whose routing their turn takes), where the records call it spent with one ahead: what the sandbox does instead of
 * letting them go by itself. Answers whether it booked them; false lets them go now.
 */
export const rebookedForReopen = async (services: Services, conversationId: string, ids: readonly string[], now: number): Promise<boolean> => {
    // A person's words only: the sandbox's and an agent's never wait on a clock (turn-admission.ts, bookingFor).
    const words = services.conversations.queued(conversationId).items.filter((item) => item.voice === "person" && ids.includes(item.id));
    const routedBy = words.at(-1);
    const until = routedBy === undefined ? undefined : await spentUntil(services, routedBy.turn, now);
    if (routedBy === undefined || until === undefined) {
        return false;
    }
    // Booked as the reopen it is, so every window can tell it from a time somebody chose (`reopenOf`).
    const reopenOf = reopenOfRouted(services, conversationId, withRuntimeDefaults(routedBy.turn));
    services.conversations.send(conversationId, { kind: "queue-rescheduled", booking: { until, reopenOf }, ids: words.map((item) => item.id) }, now);
    services.logger.info(
        { conversationId, messages: words.length, account: routedBy?.turn.account, until: new Date(until).toISOString() },
        "resume pass: words would go out on an account the records call spent, booked for its reopen instead",
    );
    return true;
};
