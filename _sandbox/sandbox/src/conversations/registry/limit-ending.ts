import type { AgentStatus, AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { opt } from "../../opt.js";
import type { ConversationState, HeldRecord } from "../actor/conversation-state.js";
import type { Ending, PersistedAgent } from "./agents-store.js";

// A spent allowance's ending as the card states it: its failure fields and the hold the actor keeps. Whether and when
// the hold goes again is not stated here: the card's `next` derives it from the hold (conversation-next.ts). Read by the
// registry's projection (agents-registry.ts).

// The spent allowance's hold as the conversation's actor keeps it right now: the one the resume pass would fire. The
// stored ending says what the refusal held; this says whether it still stands. A hold goes without any turn ending: a
// parent cancels its paused child (children.ts cancelChild), the resume pass gives it up, its one dispatch goes out and
// the start is refused.
export const limitHold = (state: ConversationState | undefined): HeldRecord | undefined =>
    state?.resume.held?.reason === "limit" ? state.resume.held : undefined;

// The failure fields, only while the card still reads as `error`; once the standing has moved on, they would describe a
// turn the board no longer shows as the last word. A spent allowance's are the rate limit's, held only while the actor
// still holds the turn (limitHold), and its reopen the hold's where the pass has timed or a pick has re-pointed it.
export const reportedFailure = (
    ending: Ending,
    status: AgentStatus,
    hold: HeldRecord | undefined,
): Partial<Pick<AgentSummary, "failure" | "failureCode" | "limitResetsAt" | "limitHeld">> => {
    if (status !== "error") {
        return {};
    }
    switch (ending.kind) {
        case "failed":
            return { ...opt("failure", ending.failure), ...opt("failureCode", ending.code) };
        case "limited":
            return {
                ...opt("failure", ending.failure),
                failureCode: "rate_limit",
                ...opt("limitResetsAt", hold?.reopensAt ?? ending.resetsAt),
                ...opt("limitHeld", ending.held && hold !== undefined ? true : undefined),
            };
        default:
            return {};
    }
};

// The entry moved to `account` (the registry's `switchAccount`). A spent allowance's ending is re-stated for the pick:
// the reset the card states for the picked account (none where it has room), in the same write, so the card never shows
// the refused account's clock in between.
export const switchedEntry = (entry: PersistedAgent, account: string, limit: { readonly resetsAt?: number } | undefined): PersistedAgent => {
    const moved = { ...entry, profile: { ...entry.profile, account } };
    if (limit === undefined || entry.ending.kind !== "limited") {
        return moved;
    }
    const { failure, held } = entry.ending;
    return { ...moved, ending: { kind: "limited", ...opt("failure", failure), ...opt("resetsAt", limit.resetsAt), held } };
};
