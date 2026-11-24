import { ORPCError } from "@orpc/server";
import { provenTurnOf } from "../../seams/workload-stamp.js";

// The oRPC doors' reading of the turn a call acts for (seams/workload-stamp.ts provenTurnOf): its proven conversation,
// none when it names none, or a FORBIDDEN refusal for a name, in the header or the body, without its proof. (2026-11-24)
// Every turn presents the same agent token, so a bare name let one conversation raise cards, needs and holds as another.

/** The proven conversation a call acts for, undefined for one naming none; throws for a name without its proof. */
export const provenTurnOrRefuse = (headers: Headers, named?: string): string | undefined => {
    const turn = provenTurnOf((name) => headers.get(name) ?? undefined, named);
    if ("refusal" in turn) {
        throw new ORPCError("FORBIDDEN", { message: `Refused: ${turn.refusal}.` });
    }
    return turn.conversationId;
};
