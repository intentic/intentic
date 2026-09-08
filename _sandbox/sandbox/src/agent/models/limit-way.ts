import type { AgentProvider, AgentTurn, TodoItem } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { handoffHistory } from "../../sessions/turn-transcript.js";
import { handoffStateNote } from "../prompt/handoff-state.js";
import { withRuntimeHistory } from "../providers/runtime-history.js";
import { opt } from "../run/opt.js";
import type { VerificationStanding } from "../verification/agent-verification.js";
import { bookLimitMove } from "./sibling-account.js";

// Computed once at a spent-allowance failure and read by both the refusal frame and the scheduler's booked move, so the
// two can't disagree. `contextTokens` costs continuing the same session (last measured context, re-read since the
// prompt cache is per-account and short-lived); `handoffTokens` costs a fresh session (capped history + measured brief,
// ~4 chars/token). `move` is the owner's policy (bookLimitMove): which account has room and whether the session
// carries; absent means hold, as before.
export interface LimitWay {
    readonly standing: VerificationStanding;
    readonly checklist?: readonly TodoItem[] | undefined;
    readonly contextTokens?: number | undefined;
    readonly handoffTokens?: number | undefined;
    readonly move?: { readonly account: string; readonly carry: boolean } | undefined;
}

const CHARS_PER_TOKEN = 4;

export const limitWayOf = async (
    services: Services,
    params: {
        // Undefined conversation ⇒ nothing held, no way-on to work out (bench runs, one-shots).
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
    const [note, rows, move] = await Promise.all([
        handoffStateNote(services, { conversationId: turn.conversationId, standing, checklist, retiredSessionId: params.sessionId }),
        handoffHistory(services, turn),
        bookLimitMove(services, {
            conversationId: turn.conversationId,
            provider: params.provider,
            model: params.model,
            refused: params.account,
            ran: params.ran,
            contextTokens,
        }),
    ]);
    const handoffChars = withRuntimeHistory("", rows).length + (note?.text.length ?? 0);
    return {
        standing,
        ...opt("checklist", checklist),
        ...opt("contextTokens", contextTokens),
        handoffTokens: Math.ceil(handoffChars / CHARS_PER_TOKEN),
        ...opt("move", move),
    };
};
