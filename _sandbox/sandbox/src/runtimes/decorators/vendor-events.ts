import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { ToolCallContent, ToolCallLocation, ToolCallStatus, ToolKind } from "@intentic/sandbox-contract/events/requests";
import { displayNameOf, mcpServerOf, toolCategoryOf, toolTarget } from "@intentic/agent-context/tool-calls";
import { opt } from "../../opt.js";
import { toolInput, toolLocations } from "../../sessions/vocabulary/tool-calls.js";
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

// A tool call's opening frame: the shared taxonomy's category unless the vendor names one, and running unless it says.
// `parentToolUseId` is the call that started the subagent making this one, which nests it under that call's card.
export const toolCallOpened = (call: {
    readonly id: string;
    readonly name: string;
    readonly category?: ToolKind;
    readonly status?: ToolCallStatus;
    readonly target?: string | undefined;
    readonly locations?: ToolCallLocation[] | undefined;
    readonly content?: ToolCallContent[] | undefined;
    // The call's input as bounded JSON text, for a call with no target (sessions/vocabulary/tool-calls.ts `toolInput`).
    readonly input?: string | undefined;
    // The MCP server the call went to, which the display name drops (agent-context mcpServerOf).
    readonly server?: string | undefined;
    readonly parentToolUseId?: string | undefined;
}): Extract<AgentEvent, { kind: "tool_call" }> => ({
    kind: "tool_call",
    id: call.id,
    name: call.name,
    category: call.category ?? toolCategoryOf(call.name),
    status: call.status ?? "in_progress",
    ...opt("target", call.target),
    ...opt("locations", call.locations),
    ...opt("content", call.content),
    ...opt("input", call.input),
    ...opt("server", call.server),
    ...opt("parentToolUseId", call.parentToolUseId),
});

/**
 * A tool call's card from what the loop said of it, built one way for every mapper: shown under the shared display name
 * and categorized by the canonical one (`mcp__browser__browser_navigate` is a fetch whatever a loop prints for it), its
 * target, the files it names, and, where no one-line target says what it does, its own arguments (a browser call's
 * `account` among them). `name` is the canonical name, or the loop's own where it has no other; a vendor's own words
 * for any part win.
 */
export const toolCard = (call: {
    readonly id: string;
    readonly name: string;
    // The call's arguments as the loop handed them, before any reading of them.
    readonly input?: unknown;
    // Where the loop ran, against which the files it names are made workspace paths; absent names none.
    readonly cwd?: string | undefined;
    readonly category?: ToolKind;
    readonly status?: ToolCallStatus;
    readonly target?: string | undefined;
    readonly locations?: ToolCallLocation[] | undefined;
    readonly content?: ToolCallContent[] | undefined;
    readonly parentToolUseId?: string | undefined;
}): Extract<AgentEvent, { kind: "tool_call" }> => {
    const target = call.target ?? toolTarget(call.input);
    const name = displayNameOf(call.name);
    // A loop's own spelling the taxonomy does not know (OpenCode's `shell`) is read by the name it is shown under.
    const category = toolCategoryOf(call.name);
    return toolCallOpened({
        id: call.id,
        name,
        category: call.category ?? (category === "other" ? toolCategoryOf(name) : category),
        ...opt("status", call.status),
        target,
        locations: call.locations ?? (call.cwd === undefined ? undefined : toolLocations(call.input, call.cwd)),
        content: call.content,
        input: toolInput(call.input, target),
        server: mcpServerOf(call.name),
        parentToolUseId: call.parentToolUseId,
    });
};
