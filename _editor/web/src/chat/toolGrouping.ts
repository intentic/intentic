import type { ChatTool } from "../composables/chat/transcript";
import { diffStat } from "./chatToolDiff";

/* Consecutive tool calls that do exactly the same thing: 30 edits to the same file, a batch of reads against
 * one directory, are noise when each gets its own card. This module groups them into a single collapsed row
 * that shows the count and aggregated stats, expandable to the individual cards. The grouping is RENDERING
 * only: the transcript model stays flat, and a group unfolds to the same cards it would have shown ungrouped.
 *
 * A run of ≥3 consecutive calls with the same display name AND same target (the file / command the card's
 * header shows) collapses. Two is too few to justify the extra affordance, it saves one line at the cost of
 * a fold the user must open to see anything. */

// The threshold below which consecutive same-type calls stay individual cards.
const GROUP_THRESHOLD = 3;

export interface ToolGroup {
    readonly kind: "group";
    readonly name: string;
    readonly category: ChatTool["category"];
    readonly target: string | undefined;
    readonly tools: readonly ChatTool[];
}

export type ToolEntry = ChatTool | ToolGroup;

const groupKey = (tool: ChatTool): string => `${tool.name}\0${tool.target ?? ""}`;

export const groupConsecutiveTools = (tools: readonly ChatTool[]): readonly ToolEntry[] => {
    if (tools.length < GROUP_THRESHOLD) {
        return tools as ToolEntry[];
    }
    const result: ToolEntry[] = [];
    let run: ChatTool[] = [];
    let runKey = ``;

    const flushRun = (): void => {
        if (run.length < GROUP_THRESHOLD) {
            for (const tool of run) {
                result.push(tool);
            }
        } else {
            result.push({
                kind: `group`,
                name: run[0]!.name,
                category: run[0]!.category,
                target: run[0]!.target,
                tools: run,
            });
        }
        run = [];
    };

    for (const tool of tools) {
        const key = groupKey(tool);
        if (key !== runKey) {
            flushRun();
            runKey = key;
        }
        run.push(tool);
    }
    flushRun();
    return result;
};

// Aggregated +/− across every tool in a group, for the collapsed header. Returns undefined when no tool
// carries structured diffs (bash calls, reads, anything that isn't an edit).
export const groupDiffSummary = (tools: readonly ChatTool[]): string | undefined => {
    let additions = 0;
    let deletions = 0;
    let hasDiffs = false;
    for (const tool of tools) {
        for (const entry of tool.content ?? []) {
            if (entry.type !== `diff`) {
                continue;
            }
            hasDiffs = true;
            const stat = diffStat(entry.oldText, entry.newText);
            additions += stat.additions;
            deletions += stat.deletions;
        }
    }
    return hasDiffs ? `+${additions} −${deletions}` : undefined;
};
