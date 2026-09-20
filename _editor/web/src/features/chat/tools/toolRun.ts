import type { IconName } from "@intentic/ui";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import { present } from "./toolPresentation";

// Summary of a turn's tool-call run for its collapsed mark (ChatTurnAsides.vue): how many top-level calls it made (a
// sub-agent's own calls count as the one delegation that spawned them) and which was the most notable.

export interface ToolRun {
    readonly count: number;
    // Icon of the run's most notable call, borrowed from that call's own presentation.
    readonly icon: IconName;
    readonly failed: boolean;
    readonly running: boolean;
}

// What the category alone is worth, once the shapes that outrank it have been ruled out.
const CATEGORY_SCORES: Partial<Record<TranscriptTool["category"], number>> = { fetch: 40, execute: 30, search: 20, read: 10 };

// `nested` stands in for `children` on a transcript page, which counts a delegation's calls rather than carrying them; a
// delegation must rank the same either way, or a reopened turn's mark changes on its own.
const delegates = (tool: TranscriptTool): boolean => tool.subagent !== undefined || (tool.children?.length ?? 0) > 0 || (tool.nested ?? 0) > 0;

const writes = (tool: TranscriptTool): boolean =>
    tool.category === `edit` || tool.category === `delete` || tool.category === `move` || (tool.content ?? []).some((entry) => entry.type === `diff`);

// Ranks a call by consequence (delegation, workspace edit, image, fetch/browser, command, search, read) rather than by
// which tool it is; the mark is the highest score.
const notability = (tool: TranscriptTool): number => {
    if (delegates(tool)) {
        return 70;
    }
    if (writes(tool)) {
        return 60;
    }
    if ((tool.content ?? []).some((entry) => entry.type === `image`)) {
        return 50;
    }
    if (tool.name.toLowerCase().startsWith(`browser `)) {
        return 40;
    }
    return CATEGORY_SCORES[tool.category] ?? 5;
};

// Picks the first call reaching the top score, so the mark's icon doesn't change as later calls of equal weight arrive
// mid-turn.
const mostNotable = (tools: readonly TranscriptTool[]): TranscriptTool | undefined => {
    let best: TranscriptTool | undefined;
    let bestScore = -1;
    for (const tool of tools) {
        const score = notability(tool);
        if (score > bestScore) {
            best = tool;
            bestScore = score;
        }
    }
    return best;
};

export const summarizeRun = (tools: readonly TranscriptTool[]): ToolRun | undefined => {
    const notable = mostNotable(tools);
    if (notable === undefined) {
        return undefined;
    }
    return {
        count: tools.length,
        icon: present(notable).icon,
        failed: tools.some((tool) => tool.status === `failed`),
        running: tools.some((tool) => tool.status === `pending` || tool.status === `in_progress`),
    };
};
