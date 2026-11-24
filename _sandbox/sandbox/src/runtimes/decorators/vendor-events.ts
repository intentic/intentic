import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { toolCard as sharedToolCard, type ToolCardCall } from "@intentic/acp-events/tool-cards";
import { opt } from "../../opt.js";
import { workspacePath } from "../../sessions/vocabulary/tool-calls.js";
import type { PlanPhaseResult } from "./plan-mode.js";

// What every vendor event mapper builds the same way: a phase's held-back capture, its summed usage, a tool call's opening.

// What a phase held back instead of streaming: the session it ran on, its plan text, and whether an error already went out.
export interface TurnCapture {
    sessionId?: string;
    planText?: string;
    errored?: boolean;
}

// A vendor's events mapped one at a time, holding what the turn reads once it settles.
export interface VendorEventMapper<E> {
    // One event to its frames, usually none or one; a finished tool call can carry a status and content together.
    readonly map: (event: E) => AgentEvent[];
    // The turn's summed usage frame, once; undefined when nothing reported any.
    readonly usage: () => AgentEvent | undefined;
    readonly capture: () => TurnCapture;
}

// A planning phase's answer from its capture; a phase that errored proposes no plan, whatever text it held.
export const planPhaseOf = (capture: TurnCapture): PlanPhaseResult => ({
    sessionId: capture.sessionId,
    planText: capture.planText,
    errored: capture.errored === true,
});

// One report of a turn's tokens; `costUsd` only where the vendor prices the call.
export interface TurnTokens {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cacheReadTokens: number;
    readonly cacheCreationTokens: number;
    readonly costUsd?: number;
}

export interface UsageTotals {
    // A keyed report replaces that key's earlier snapshot; an unkeyed one adds to the rest.
    readonly add: (tokens: TurnTokens, key?: string) => void;
    // No report means no frame rather than zeros, and a cost only when some report carried one.
    readonly frame: () => AgentEvent | undefined;
}

export const usageTotals = (): UsageTotals => {
    const reports = new Map<string | symbol, TurnTokens>();
    return {
        add: (tokens, key) => {
            reports.set(key ?? Symbol("report"), tokens);
        },
        frame: () => {
            if (reports.size === 0) {
                return undefined;
            }
            const sum = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0 };
            let costUsd: number | undefined;
            for (const report of reports.values()) {
                sum.inputTokens += report.inputTokens;
                sum.outputTokens += report.outputTokens;
                sum.cacheReadTokens += report.cacheReadTokens;
                sum.cacheCreationTokens += report.cacheCreationTokens;
                if (report.costUsd !== undefined) {
                    costUsd = (costUsd ?? 0) + report.costUsd;
                }
            }
            return { kind: "usage", ...sum, ...opt("costUsd", costUsd) };
        },
    };
};

// A tool call's opening frame and its card are built in @intentic/acp-events/tool-cards, where a computer's turns
// build theirs too. `toolCallOpened` is handed on as it is; `toolCard` reads the files a call names the daemon's way
// (`workspacePath`).
export { toolCallOpened } from "@intentic/acp-events/tool-cards";

/** A tool call's card from what the loop said of it (acp-events `toolCard`), its files read onto the workspace's route space. */
export const toolCard = (call: Omit<ToolCardCall, "pathOf">): Extract<AgentEvent, { kind: "tool_call" }> => sharedToolCard({ pathOf: workspacePath, ...call });
