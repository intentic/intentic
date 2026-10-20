import { type AgentProvider, withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../../../composition.js";
import type { TurnInput } from "../../../../seams/turn-starter.js";
import { spentRung } from "../../../models/role-model-quota.js";
import { allowanceWall } from "../../../../usage/serviceability/serviceability.js";
import { reopenOfRouted } from "../booking-ask.js";

/* WHAT GOES OUT WITH NOBODY PRESSING ANYTHING NEVER GOES INTO AN ALLOWANCE THE RECORDS CALL SPENT. A person's words the
   sandbox releases by itself (a memory hold once room comes back, a booking whose time came) used to go straight to the
   provider whatever the records said, to be refused within seconds; a refusal that came after the turn began then turned
   those words into a held turn, re-run hours later behind a note of the sandbox's own instead of as they were written
   (2026-10-17). spent-door.ts holds a turn the sandbox starts itself the same way; this is the other half, for a person's
   words the sandbox lets go: they are booked for the reopen instead, where every window draws them as scheduled, and go
   then. A person's own press still always goes: they may know what the records do not. */

// The request a release would make, as far as who pays for it: the provider, the account, the model.
type Routed = Pick<TurnInput, "agent" | "harness" | "account" | "model"> & { readonly conversationId: string };

/**
 * When the account these words would go on lets them through again, in milliseconds, where the records call it spent
 * with a reopening still ahead; undefined to let them go now (room, no reading, a spent reading naming no reopening, or a
 * reopening already past). The account is the one the words name, else the conversation's own; with neither, every
 * account of the provider must read spent, as spent-door.ts reads it.
 */
export const spentUntil = async (services: Services, turn: Routed, now: number = Date.now()): Promise<number | undefined> => {
    const { agent } = withRuntimeDefaults(turn);
    const model = turn.model === undefined || turn.model === "" ? undefined : turn.model;
    const account = turn.account ?? services.agents.entry(turn.conversationId)?.profile.account;
    const reopensAt =
        account === undefined
            ? (await spentRung(services, { provider: agent, model: model ?? "" }, now))?.reopensAt
            : await accountReopening(services, agent, account, model, now);
    return reopensAt === undefined || reopensAt * 1000 <= now ? undefined : reopensAt * 1000;
};

// One account's reopening while the records call it spent (serviceability.ts allowanceWall); undefined for any other
// verdict, a wall with no instant named, or a failed read.
const accountReopening = async (services: Services, provider: AgentProvider, account: string, model: string | undefined, now: number): Promise<number | undefined> => {
    try {
        return (await allowanceWall(services, provider, account, model === undefined ? undefined : { id: model }, now))?.reopensAt;
    } catch (error) {
        // An unread verdict gates nothing: the words go, as they did before this gate, and the provider answers.
        services.logger.warn({ err: error, provider, account }, "allowance gate: could not read the account's verdict, the words go as they are");
        return undefined;
    }
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
