import type { AgentProvider, AgentTurn, TodoItem } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { handoffHistory } from "../../sessions/turn-transcript.js";
import { handoffStateNote } from "../prompt/handoff-state.js";
import { withRuntimeHistory } from "../providers/runtime-history.js";
import { opt } from "../run/opt.js";
import type { VerificationStanding } from "../verification/agent-verification.js";
import { bookLimitMove } from "./sibling-account.js";

/* THE WAY ON FROM A SPENT ALLOWANCE, worked out once at the failure and read twice: by the frame that tells the
 * chat and the card what each press would cost and where a policy is already taking the turn, and by the held
 * entry the scheduler performs a booked move from (turn-resume.ts). One decision, so the two cannot disagree.
 *
 * WHAT IT MEASURES. `contextTokens` is what a press that keeps the session re-reads, on this account at the
 * reset or carried to another: the context as the last usage frame measured it, read cold because a prompt
 * cache is per account and expires in minutes. `handoffTokens` is what a press that opens a fresh session pays
 * instead: the capped record envelope (runtime-history.ts) plus the sandbox's measured brief (handoff-state.ts),
 * rendered here exactly as the fresh turn would render them, and counted at four characters a token, which is
 * the honest order of magnitude for prose and paths. Neither is a promise; both are the numbers the offer was
 * missing when it read "Continue" over a button that could cost a hundred thousand tokens or six.
 *
 * WHAT IT DECIDES. `move` is the owner's policy applied (sibling-account.ts bookLimitMove): the account with
 * room, and whether the session comes along. Absent means hold, or the appointment, exactly as before.
 *
 * Costs one transcript read and a handful of git statuses, on a failure path, once. */
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
        // Undefined conversation ⇒ nothing is held and there is no way on to work out (the bench, a one-shot).
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
