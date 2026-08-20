import type { IconName } from "@intentic/ui";
import type { ChatTool } from "../composables/chat/transcript";
import { present } from "./toolPresentation";

/* A TURN'S RUN OF TOOL CALLS, reduced to the mark that stands in for it while they are hidden (see
 * ChatToolRun.vue).
 *
 * The mark says two things and no more: HOW MANY calls the turn made, and WHAT the most notable of them was.
 * Both are answers to the question somebody skimming actually has, "did anything happen between these two
 * paragraphs, and was any of it consequential?", and neither requires reading a single row.
 *
 * The count is of top-level calls, which is exactly what opening the mark reveals. A sub-agent's own calls stay
 * counted as the one delegation that spawned them, because that is how they render: nested under it. */

export interface ToolRun {
    readonly count: number;
    // The icon of the run's most notable call, borrowed from that call's own presentation so a browser run wears
    // the globe and a delegation wears the delegation mark, exactly as their rows would.
    readonly icon: IconName;
    readonly failed: boolean;
    readonly running: boolean;
}

/* HOW NOTABLE A CALL IS. Ordered by what a reader would want to know happened, most consequential first: work
 * handed to another agent, a change to the workspace, a picture that came back, a page, a command, a search, a
 * read. One number per call, so the run's mark is simply the highest.
 *
 * Deliberately about what a call DID rather than which tool it was: an Edit and a shell `>` redirection are the
 * same event to a reader, and both outrank a hundred greps. */
const notability = (tool: ChatTool): number => {
    if (tool.subagent !== undefined || (tool.children?.length ?? 0) > 0) {
        return 70;
    }
    if (tool.category === `edit` || tool.category === `delete` || tool.category === `move`) {
        return 60;
    }
    const content = tool.content ?? [];
    if (content.some((entry) => entry.type === `diff`)) {
        return 60;
    }
    if (content.some((entry) => entry.type === `image`)) {
        return 50;
    }
    if (tool.category === `fetch` || tool.name.toLowerCase().startsWith(`browser `)) {
        return 40;
    }
    if (tool.category === `execute`) {
        return 30;
    }
    if (tool.category === `search`) {
        return 20;
    }
    if (tool.category === `read`) {
        return 10;
    }
    return 5;
};

/* The run's most notable call, the FIRST of the highest-scoring ones, so a mark doesn't change its face as
 * later calls of equal weight land while the turn is still going. */
const mostNotable = (tools: readonly ChatTool[]): ChatTool | undefined => {
    let best: ChatTool | undefined;
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

export const summarizeRun = (tools: readonly ChatTool[]): ToolRun | undefined => {
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
