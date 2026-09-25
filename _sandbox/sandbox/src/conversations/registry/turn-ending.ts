import { type AgentSummary, RETRY_LADDER_TRIES, type TurnEnding } from "@intentic/sandbox-contract";
import type { HeldTurn } from "../../agent/run/turn/turn-resume.js";
import type { Services } from "../../composition.js";

// How a conversation's last turn ended, as its card offers to move it on: stopped, out of allowance, or a provider outage.

export type EndingDeps = Pick<Services, "agents" | "conversations">;

// Whether the held turn ran, what each way of moving on costs, and where a policy is sending it.
const heldEnding = (held: HeldTurn): NonNullable<TurnEnding["held"]> => ({
    ran: held.ran,
    ...(held.contextTokens !== undefined ? { contextTokens: held.contextTokens } : {}),
    ...(held.handoffTokens !== undefined ? { handoffTokens: held.handoffTokens } : {}),
    ...(held.move !== undefined ? { moving: held.move.account } : {}),
});
// The live hold, never a summary flag: a restart clears the hold, so only it backs a re-run rather than a message.
// A stopped hold also says how far its automatic re-runs got, once any has gone.
const heldOn = (deps: EndingDeps, id: string): Pick<TurnEnding, "held" | "retries"> => {
    const held = deps.conversations.state(id)?.resume.held;
    if (held === undefined) {
        return {};
    }
    const climbed = held.reason === "stopped" && held.tries > 0;
    return { held: heldEnding(held), ...(climbed ? { retries: { made: held.tries, max: RETRY_LADDER_TRIES } } : {}) };
};
const failureEnding = (deps: EndingDeps, id: string, summary: AgentSummary): TurnEnding | undefined => {
    if (summary.failureCode === "rate_limit") {
        return {
            reason: "limit",
            ...(summary.limitResetsAt !== undefined ? { resetsAt: summary.limitResetsAt } : {}),
            ...heldOn(deps, id),
            ...(summary.limitScheduled === true ? { scheduled: true } : {}),
        };
    }
    if (summary.failureCode === "provider-outage") {
        return { reason: "outage" };
    }
    // A coded failure names something to repair first, so no offer beats a press that would only re-fail.
    // Uncoded is stopped work: nothing to repair, so the press just carries on.
    return summary.failureCode === undefined ? { reason: "stopped", ...heldOn(deps, id) } : undefined;
};
// Off the projected `get` status, never raw `entry.status`, which stays `interrupted` through a running turn. Adds
// reasons stop/kill don't cover (a spent allowance, an outage); repair failures are excluded.
export const endingOf = (deps: EndingDeps, id: string): TurnEnding | undefined => {
    const summary = deps.agents.get(id);
    if (summary === undefined) {
        return undefined;
    }
    if (summary.status === "stopped" || summary.status === "interrupted") {
        return { reason: "stopped" };
    }
    // Reads the failure the card currently reports; a resumed, landed or overtaken turn has none (agents-registry).
    return summary.status === "error" ? failureEnding(deps, id, summary) : undefined;
};
