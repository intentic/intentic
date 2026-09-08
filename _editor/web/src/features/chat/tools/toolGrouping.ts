import type { TranscriptTool } from "@intentic/sandbox-contract";
import { diffStat } from "./chatToolDiff";

// Groups consecutive tool calls that do the same thing (30 edits to one file, a batch of reads) into one
// collapsed row with a count and aggregated stats, expandable to the individual cards. Rendering only: the
// transcript model stays flat. Collapses a run of 3+ with the same name and target; two is too few to justify
// the fold.

// The threshold below which consecutive same-type calls stay individual cards.
const GROUP_THRESHOLD = 3;

export interface ToolGroup {
    readonly kind: "group";
    readonly name: string;
    readonly category: TranscriptTool["category"];
    readonly target: string | undefined;
    readonly tools: readonly TranscriptTool[];
}

export type ToolEntry = TranscriptTool | ToolGroup;

const groupKey = (tool: TranscriptTool): string => `${tool.name}\0${tool.target ?? ""}`;

export const groupConsecutiveTools = (tools: readonly TranscriptTool[]): readonly ToolEntry[] => {
    if (tools.length < GROUP_THRESHOLD) {
        return tools as ToolEntry[];
    }
    const result: ToolEntry[] = [];
    let run: TranscriptTool[] = [];
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

// Aggregated +/- across every tool in a group, for the collapsed header; undefined when nothing in the group
// carries a structured diff.
export const groupDiffSummary = (tools: readonly TranscriptTool[]): string | undefined => {
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
