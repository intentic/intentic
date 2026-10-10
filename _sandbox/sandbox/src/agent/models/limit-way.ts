import { tokensOfChars } from "@intentic/base/format";
import type { AgentProvider, AgentTurn, HandoffOffer, TodoItem } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { handoffHistory } from "../../sessions/turn-transcript.js";
import { handoffStateNote } from "../prompt/handoff-state.js";
import { withRuntimeHistory } from "../providers/runtime-history.js";
import { handoffOfferOf } from "../providers/limit-handoff.js";
import { opt } from "../../opt.js";
import type { VerificationStanding } from "../verification/agent-verification.js";
import { bookLimitMove } from "./sibling-account.js";

// Computed once at a spent-allowance failure and read by both the refusal frame and the scheduler's booked move, so the
// two can't disagree. `contextTokens` costs continuing the same session (last measured context, re-read since the
// prompt cache is per-account and short-lived); `handoffTokens` costs a fresh session (capped history + measured brief,
// ~4 chars/token). `move` is the owner's policy (bookLimitMove): which account has room and whether the session
// carries; absent means hold, as before. `handoff` is the choice of ways on a person gets (limit-handoff.ts).
export interface LimitWay {
    readonly standing: VerificationStanding;
    readonly checklist?: readonly TodoItem[] | undefined;
    readonly contextTokens?: number | undefined;
    readonly handoffTokens?: number | undefined;
    readonly move?: { readonly account: string; readonly carry: boolean } | undefined;
    // How the held turn can continue once its cache is cold, and which way the sandbox would take (limit-handoff.ts).
    readonly handoff?: HandoffOffer | undefined;
}

export const limitWayOf = async (
    services: Services,
    params: {
        // Undefined conversation ⇒ nothing held, no way-on to work out (bench runs, sealed requests).
        readonly turn: AgentTurn;
        readonly provider: AgentProvider;
        readonly model: string | undefined;
        readonly account: string | undefined;
        readonly ran: boolean;
        readonly standing: VerificationStanding;
        readonly checklist: readonly TodoItem[] | undefined;
        readonly contextTokens: number | undefined;
        readonly sessionId: string | undefined;
    },
): Promise<LimitWay | undefined> => {
    const { standing, checklist, contextTokens } = params;
    if (params.turn.conversationId === undefined) {
        return undefined;
    }
    const turn = { ...params.turn, conversationId: params.turn.conversationId };
    const [note, rows] = await Promise.all([
        handoffStateNote(services, { conversationId: turn.conversationId, standing, checklist, retiredSessionId: params.sessionId }),
        handoffHistory(services, turn),
    ]);
    const handoffTokens = tokensOfChars(withRuntimeHistory("", rows).length + (note?.text.length ?? 0));
    const handoff = await handoffOfferOf(services, { turn, ran: params.ran, sessionId: params.sessionId, contextTokens, handoffTokens, rows }).catch(
        (error: unknown) => {
            services.logger.warn({ err: error, conversationId: turn.conversationId }, "hand-off: could not work out the ways on");
            return undefined;
        },
    );
    const move = await bookLimitMove(services, {
        conversationId: turn.conversationId,
        provider: params.provider,
        model: params.model,
        refused: params.account,
        ran: params.ran,
        contextTokens,
        ...opt("carry", handoff === undefined ? undefined : (handoff.chosen ?? handoff.suggested) === "carry"),
    });
    return {
        standing,
        ...opt("checklist", checklist),
        ...opt("contextTokens", contextTokens),
        handoffTokens,
        ...opt("move", move),
        ...opt("handoff", handoff),
    };
};
