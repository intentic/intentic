import type { DeviceAgentOp } from "@intentic/sandbox-contract";
import type { NoticeModel } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// ONE PRESS OF AN AGENT VERB, AS ONE THING WITH AN ENDING. The page used to draw a run as three loose pieces under the
// row — the machine's raw log, a muted sentence, and the concern that had asked for it still standing above them with
// its button live again — so a reader who pressed "Forget them" was left looking at the question they had just
// answered, and nothing on screen said the work was over. A run is now a strip with a state: working, waiting for the
// machine to come back, done, or refused, each with a headline in the page's own words. The log is evidence behind it.

export type AgentRunState = `running` | `waiting` | `done` | `failed`;

/** The links reading a "Forget them" press was made against: what it set out to drop, and what that leaves. */
export interface LinksAsked {
    readonly total: number;
    readonly unreachable: number;
}

export interface AgentRun {
    readonly op: DeviceAgentOp;
    readonly state: AgentRunState;
    /** The machine's own output, verbatim. Shown on request, never instead of the headline. */
    readonly lines: readonly string[];
    /** The machine's closing sentence, when it got to send one. */
    readonly said?: string | undefined;
    /** What the page is waiting on, once the call has ended without the answer (a restarted agent coming back). */
    readonly waiting?: string | undefined;
    readonly links?: LinksAsked | undefined;
    /** The machine's refusal, and the same act as a line to type there. */
    readonly failure?: { readonly notice: NoticeModel; readonly command?: string | undefined } | undefined;
}

// Counted so the headline can say how much was done, never only that something was.
const count = (links: LinksAsked | undefined): number | undefined => (links === undefined || links.unreachable === 0 ? undefined : links.unreachable);

/** The strip's headline: what is happening, or what happened, in one line. */
export const agentRunTitle = (run: AgentRun): string => {
    const n = count(run.links);
    switch (run.op) {
        case `forget-unreachable`:
            if (run.state === `failed`) {
                return t(`sandbox.agentRun.forgetFailed`);
            }
            if (run.state === `done`) {
                return n === undefined ? t(`sandbox.agentRun.forgotSome`) : t(`sandbox.agentRun.forgot`, { count: n }, n);
            }
            return n === undefined ? t(`sandbox.agentRun.forgettingSome`) : t(`sandbox.agentRun.forgetting`, { count: n }, n);
        case `upgrade`:
            return run.state === `failed`
                ? t(`sandbox.agentRun.updateFailed`)
                : run.state === `done`
                  ? t(`sandbox.agentRun.updated`)
                  : run.state === `waiting`
                    ? t(`sandbox.agentRun.comingBack`)
                    : t(`sandbox.agentRun.updating`);
        case `restart`:
            return run.state === `failed`
                ? t(`sandbox.agentRun.restartFailed`)
                : run.state === `done`
                  ? t(`sandbox.agentRun.restarted`)
                  : run.state === `waiting`
                    ? t(`sandbox.agentRun.comingBack`)
                    : t(`sandbox.agentRun.restarting`);
        default:
            return run.op satisfies never;
    }
};

/**
 * The line under the headline. A finished drop says what it left, in the machine's own unit, instead of the machine's
 * "what it removed is in the lines above" — which pointed at a log the reader should not need to read. Everything
 * else says the machine's own closing sentence, or what the page is waiting on.
 */
export const agentRunDetail = (run: AgentRun): string | undefined => {
    if (run.state === `waiting`) {
        return run.waiting;
    }
    if (run.state === `done` && run.op === `forget-unreachable` && count(run.links) !== undefined && run.links !== undefined) {
        const left = run.links.total - run.links.unreachable;
        return left === 0 ? t(`sandbox.agentRun.noLinksLeft`) : t(`sandbox.agentRun.stillConnected`, { count: left }, left);
    }
    return run.state === `done` ? run.said : undefined;
};

/** What a refusal is titled when the machine gave no sentence of its own; one per verb, never "update" for all three. */
export const agentRefusal = (op: DeviceAgentOp): string =>
    op === `forget-unreachable`
        ? `That device didn't drop its unreachable links.`
        : op === `restart`
          ? `That device wouldn't restart its agent.`
          : `That device wouldn't update its agent.`;
