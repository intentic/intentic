import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { opt } from "../../opt.js";
import type { FailedEnding } from "../registry/agents-store.js";

// What a failed turn's ending records on its conversation, read off the turn's error frame (conversation-decide.ts).

// Long enough for a provider's own explanation; short enough that a stack trace or error page can't ride into the
// roster. One bounded line, no newlines; empty collapses to `undefined`.
const MAX_FAILURE_LENGTH = 400;
export const sanitizeFailure = (message: string): string | undefined => {
    const clean = message.replaceAll(/\s+/gu, " ").trim().slice(0, MAX_FAILURE_LENGTH);
    return clean === "" ? undefined : clean;
};

// The frame's own verdict decides, not the code, except a rate limit: its reopening can be hours away, so it is
// recorded as a failure rather than hidden as work in progress.
export const comingBackNow = (event: Extract<AgentEvent, { kind: "error" }>): boolean => event.autoResume === "scheduled" && event.code !== "rate_limit";

// A spent allowance is its own kind: the only failure with a reopening, a hold, a booking and a move to carry.
export const failureOf = (event: Extract<AgentEvent, { kind: "error" }>): FailedEnding => {
    const failure = sanitizeFailure(event.message);
    if (event.code !== "rate_limit") {
        return { kind: "failed", ...opt("failure", failure), ...opt("code", event.code) };
    }
    return {
        kind: "limited",
        ...opt("failure", failure),
        ...opt("resetsAt", event.resetsAt),
        held: event.held !== undefined,
        // The daemon's own verdict at the failure; the firing pass asks the answer again at the reset, so a changed
        // answer re-books it (agents-registry `rebooked`) to keep card and schedule in agreement.
        scheduled: event.autoResume === "scheduled",
        ...opt("moving", event.held?.moving),
        ...opt("nextAt", event.autoResume === "scheduled" ? event.nextAt : undefined),
    };
};
