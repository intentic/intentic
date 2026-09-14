import { fixAttemptOf, latestFixAttempt, nextFixAttemptId } from "../ids/conversation-ids.js";
import type { AgentSummary } from "../schemas/agents.js";
import { type FixStance, fixStance } from "./fix-stance.js";

/* WHAT A PRESS ON A FAILURE'S FIX CONTROL DOES, decided once for every surface that has one — the push question in the shell, the pipelines board's rows. */

// How the reader ended the picker, when they did; absent is the plain press on the button.
export type FixResume = "continue" | "start-over";

export type FixAttemptPlan =
    // Nothing live answers this failure, or the last answer landed: open the next attempt with the full prompt.
    | { readonly kind: "new"; readonly conversationId: string; readonly attempt: number }
    // The latest attempt ended without a fix: carry on in it, with a nudge rather than the whole opening prompt.
    | { readonly kind: "continue"; readonly conversationId: string; readonly attempt: number }
    // Set the latest attempt aside (stopped first if still running) and open the next one on a clean worktree.
    | {
          readonly kind: "start-over";
          readonly retire: string;
          readonly stopFirst: boolean;
          readonly conversationId: string;
          readonly attempt: number;
      }
    // The latest attempt is still in play: working, parked on the reader, or holding a fix to review. Open it instead.
    | { readonly kind: "busy"; readonly conversationId: string; readonly stance: FixStance };

// `roster` is the live fleet; `knownIds` is every conversation id that exists, archived ones included, since the next
// attempt's number must clear the archive too (conversation-ids.ts, nextFixAttemptId).
export const planFixAttempt = (base: string, roster: readonly AgentSummary[], knownIds: Iterable<string>, resume?: FixResume): FixAttemptPlan => {
    const latest = latestFixAttempt(base, roster);
    const stance = latest === undefined ? undefined : fixStance(latest.agent);
    const known = [...knownIds, ...(latest === undefined ? [] : [latest.agent.id])];
    const next = (): { conversationId: string; attempt: number } => {
        const conversationId = nextFixAttemptId(base, known);
        return { conversationId, attempt: fixAttemptOf(base, conversationId) ?? 1 };
    };
    if (latest === undefined || stance === undefined || stance.kind === "landed") {
        return { kind: "new", ...next() };
    }
    if (resume === "start-over") {
        return { kind: "start-over", retire: latest.agent.id, stopFirst: stance.kind === "working", ...next() };
    }
    if (stance.retry) {
        return { kind: "continue", conversationId: latest.agent.id, attempt: latest.attempt };
    }
    return { kind: "busy", conversationId: latest.agent.id, stance };
};
