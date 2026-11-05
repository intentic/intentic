import { repeatsUntilRepaired } from "@intentic/sandbox-contract/policy/failure-codes";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { TranscriptRow } from "@intentic/sandbox-contract/events/transcript";

/* A WAY OUT OF A WALL. Some failures come back the same however often the turn is sent again: the conversation's own
   copy of the workspace that will not come up (`workspace-broken`, a code the contract marks `repeats`), or any failure
   that has already ended two turns in a row the same way before the model answered (AgentSummary.failureRepeats). For
   those the daemon withdraws the Continue press, and the chat offers the ways out instead, every one a press: a new
   conversation carrying this one, another model, and trying again here once more (2026-11-05: a person pressed Continue
   twenty times into one such wall). */

/** One way out, in the order it is offered. */
export type WayOutKind = `newConversation` | `otherModel` | `retry`;

/** What the wall is known to stand in: the conversation's copy of the workspace, or nothing anyone named. */
export type WayOutLayer = `workspace` | `unknown`;

export interface WayOut {
    readonly layer: WayOutLayer;
    // How many turns in a row ended this way, as the card counts them: 1 until the daemon has counted a second.
    readonly repeats: number;
    readonly recommended: WayOutKind;
    readonly ways: readonly WayOutKind[];
}

/** The card's facts a way out is read off. */
export type WayOutFacts = Partial<Pick<AgentSummary, `failureCode` | `failureRepeats`>> & { readonly status?: string | undefined };

// The workspace is the conversation's own: a new conversation gets a copy of its own, while another model would run in
// the same broken one, and the daemon already made the one repair it can.
const WORKSPACE_WAYS: readonly WayOutKind[] = [`newConversation`, `retry`];
// Nothing says what the wall is: every way is worth offering, a new conversation first since it leaves the most behind.
const UNKNOWN_WAYS: readonly WayOutKind[] = [`newConversation`, `otherModel`, `retry`];

/** The ways out of the conversation's last failure; undefined where pressing on is still the way (or nothing failed). */
export const wayOutOf = ({ status, failureCode, failureRepeats }: WayOutFacts): WayOut | undefined => {
    if (status !== `error`) {
        return undefined;
    }
    const repeats = failureRepeats ?? 1;
    if (repeatsUntilRepaired(failureCode)) {
        return { layer: `workspace`, repeats, recommended: WORKSPACE_WAYS[0]!, ways: WORKSPACE_WAYS };
    }
    if (repeats >= 2) {
        return { layer: `unknown`, repeats, recommended: UNKNOWN_WAYS[0]!, ways: UNKNOWN_WAYS };
    }
    return undefined;
};

/**
 * Where the new conversation is cut: above the last message the person sent when nothing answered it since (the failed
 * turn never ran), so its words reopen in the new composer for a press of Send; else below everything, the whole
 * conversation carried.
 */
export const wayOutCut = (messages: readonly Pick<TranscriptRow, `role`>[]): number => {
    const asked = messages.findLastIndex((message) => message.role === `user`);
    if (asked < 0 || messages.slice(asked + 1).some((message) => message.role === `assistant`)) {
        return messages.length;
    }
    return asked;
};
