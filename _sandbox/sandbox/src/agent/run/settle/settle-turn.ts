import type { Services } from "../../../composition.js";
import type { TurnActivity } from "../frames/frame-effects.js";
import type { SettlementPlan } from "./turn-settlement.js";

// Carries a settlement plan out in the order a turn's exit always has: the resume records first, then the rows and
// re-reads, each fire-and-forget with its own named failure line. Nothing here runs a check or sends the turn back to
// work: the model decides when it is done, and its work is checked after it lands (workspace/deps/verify-deps.ts).

// Tells the conversation what the turn's exit leaves the resume pass: a held turn, or proof the run got somewhere.
const recordResumes = (deps: Pick<Services, "conversations">, { hold }: SettlementPlan): void => {
    if (hold?.kind === "held") {
        deps.conversations.send(hold.held.input.conversationId, { kind: "turn-held", held: hold.held });
    } else if (hold?.kind === "got-somewhere") {
        deps.conversations.send(hold.conversationId, { kind: "turn-got-somewhere" });
    }
};

export const performSettlement = (
    deps: Pick<Services, "usage" | "headroom" | "events" | "logger" | "conversations">,
    plan: SettlementPlan,
    turn: {
        // Appends one of the turn's own rows to the activity log.
        readonly record: (event: TurnActivity) => void;
        // Records the outbound calls whose results never arrived.
        readonly flush: () => void;
    },
): void => {
    recordResumes(deps, plan);
    // Before the settle that files it: the actor keeps it with the turn's other readings until then.
    if (plan.proof !== undefined) {
        deps.conversations.send(plan.proof.conversationId, { kind: "proof-noted", proof: plan.proof.proof });
    }
    turn.record(plan.completion);
    if (plan.headroomRefresh !== undefined) {
        void deps.headroom.refresh(plan.headroomRefresh);
    }
    void deps.usage.record(plan.usage).catch((error: unknown) => deps.logger.warn({ err: error }, "usage: ledger append failed"));
    turn.flush();
    if (plan.snapshot !== undefined) {
        deps.events.publish("tree.changed", { label: plan.snapshot });
    }
};
