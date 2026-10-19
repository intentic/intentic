import type { AgentStatus, AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import { opt } from "../../opt.js";
import type { ConversationState, HeldRecord } from "../actor/conversation-state.js";
import type { LimitBooking } from "../actor/limit-booking.js";
import type { AgentsRegistry } from "./agents-registry.js";
import type { Ending, PersistedAgent } from "./agents-store.js";

// A spent allowance's ending as the card states it: its failure fields, the hold the actor keeps, and its booking, held
// to the one rule the resume pass fires by (limit-booking.ts). Read by the registry's projection (agents-registry.ts).

// The spent allowance's hold as the conversation's actor keeps it right now: the one the resume pass would fire. The
// stored ending says what the refusal booked; this says whether it still stands. A hold goes without any turn ending:
// a parent cancels its paused child (children.ts cancelChild), the resume pass gives it up, its one dispatch goes out
// and the start is refused. Read only from the stored ending, each of those left the card saying a re-run was booked
// that nothing would ever make, a card in Active for good, its family's card lifted there with it.
export const limitHold = (state: ConversationState | undefined): HeldRecord | undefined =>
    state?.resume.held?.reason === "limit" ? state.resume.held : undefined;

// The failure fields, only while the card still reads as `error`; once the standing has moved on, they would describe a
// turn the board no longer shows as the last word. A spent allowance's are the rate limit's, its hold, booking and move
// each only while the actor still holds the turn (limitHold), and the booking and move only until that hold fired.
export const reportedFailure = (
    ending: Ending,
    status: AgentStatus,
    hold: HeldRecord | undefined,
): Partial<Pick<AgentSummary, "failure" | "failureCode" | "limitResetsAt" | "limitHeld" | "limitScheduled" | "limitMoving" | "limitNextAt">> => {
    if (status !== "error") {
        return {};
    }
    switch (ending.kind) {
        case "failed":
            return { ...opt("failure", ending.failure), ...opt("failureCode", ending.code) };
        case "limited": {
            const booked = hold !== undefined && !hold.fired;
            return {
                ...opt("failure", ending.failure),
                failureCode: "rate_limit",
                ...opt("limitResetsAt", ending.resetsAt),
                ...opt("limitHeld", ending.held && hold !== undefined ? true : undefined),
                ...opt("limitScheduled", ending.scheduled && booked ? true : undefined),
                ...opt("limitMoving", booked ? ending.moving : undefined),
                ...opt("limitNextAt", ending.scheduled && booked ? ending.nextAt : undefined),
            };
        }
        default:
            return {};
    }
};

// A held limit's booking as the card states it: the one rule the resume pass fires by (limit-booking.ts), read off the
// live hold and the answer the pass will now give it, and the instant it goes (`nextAt`, epoch s), which the pass reads
// with the wall in front of the account it goes on (limit-due.ts), so the card says when it actually goes. A booking read once at the failure would go on saying whatever was
// true then: "Resume all when it's back" armed every held turn and every card still read as waiting on a press. Read off
// the stored ending's reset instead of the hold's, a child whose reset lay past its horizon (held with no instant, on
// purpose) read "resends …" in Active after any answer, while nothing would ever fire it (2026-10-19).
export const rebooked = (ending: Ending, booking: LimitBooking | undefined): Ending => {
    if (ending.kind !== "limited" || !ending.held) {
        return ending;
    }
    return {
        kind: "limited",
        ...opt("failure", ending.failure),
        ...opt("resetsAt", ending.resetsAt),
        held: true,
        scheduled: booking !== undefined,
        ...opt("moving", booking?.moving),
        ...opt("nextAt", booking === undefined ? undefined : Math.ceil(booking.at / 1000)),
    };
};

// The entry with its held limit's booking held to `booking`, and its reset stated where the hold has since been timed;
// undefined where nothing would change, which is every beat but the one where something did.
const withLimitBooking = (entry: PersistedAgent | undefined, booking: LimitBooking | undefined, resetsAt: number | undefined): PersistedAgent | undefined => {
    const ending = entry?.ending;
    if (entry === undefined || ending?.kind !== "limited" || !ending.held) {
        return undefined;
    }
    const timed = resetsAt !== undefined && ending.resetsAt === undefined;
    const next = rebooked(timed ? { ...ending, resetsAt } : ending, booking);
    if (next.kind !== "limited" || (!timed && ending.scheduled === next.scheduled && ending.moving === next.moving && ending.nextAt === next.nextAt)) {
        return undefined;
    }
    return { ...entry, ending: next };
};

// The registry's `keepLimitBooking` over its own reads and writes: writes only an entry that changed, and answers whether
// there was one.
export const limitBookingKeeper =
    (
        entryOf: (id: string) => PersistedAgent | undefined,
        amend: (id: string, change: (entry: PersistedAgent) => PersistedAgent) => Promise<AgentSummary | undefined>,
    ): AgentsRegistry["keepLimitBooking"] =>
    async (id, booking, resetsAt) => {
        const changed = withLimitBooking(entryOf(id), booking, resetsAt);
        return changed !== undefined && (await amend(id, () => changed)) !== undefined;
    };

// The entry moved to `account` (the registry's `switchAccount`). A spent allowance's ending is re-stated for the pick: the
// reset the card states for the picked account (none where it has room), and the booking the pick leaves its held turn,
// in the same write, so the one broadcast already says when the turn goes and the card never shows the refused
// account's clock in between.
export const switchedEntry = (
    entry: PersistedAgent,
    account: string,
    limit: { readonly resetsAt?: number; readonly booking?: LimitBooking } | undefined,
): PersistedAgent => {
    const moved = { ...entry, profile: { ...entry.profile, account } };
    if (limit === undefined || entry.ending.kind !== "limited") {
        return moved;
    }
    const { failure, held, scheduled } = entry.ending;
    return { ...moved, ending: rebooked({ kind: "limited", ...opt("failure", failure), ...opt("resetsAt", limit.resetsAt), held, scheduled }, limit.booking) };
};
