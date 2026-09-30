import type { TranscriptTool } from "@intentic/sandbox-contract";
import { delegates as startsSubagent } from "./toolPresentation";

// Summary of a turn's tool-call run for its node on the spine (ChatTurnAsides.vue): how many top-level calls it made (a
// sub-agent's own calls count as the one delegation that spawned them), what kinds they were, and how it went. The
// node itself shows only the count; the kinds are what its hover card breaks that count into.

// What a call did, by consequence rather than by which tool it was. Declared in the order the card lists them: what
// changed the world first, what only looked at it last.
export const RUN_KINDS = [`subagents`, `edits`, `commands`, `web`, `searches`, `reads`, `other`] as const;
export type RunKind = (typeof RUN_KINDS)[number];

export interface ToolRun {
    readonly count: number;
    // Calls per kind, in RUN_KINDS order; kinds the run made no call of are left out.
    readonly kinds: readonly { readonly kind: RunKind; readonly count: number }[];
    // Calls that failed, so the card can say how many and the node can turn.
    readonly failed: number;
    readonly running: boolean;
}

// `nested` stands in for `children` on a transcript page, which counts a delegation's calls rather than carrying them; a
// delegation must read the same either way, or a reopened turn's card changes on its own. A spawned subagent's call
// counts as one too, though its calls live in its own conversation.
const delegates = (tool: TranscriptTool): boolean => startsSubagent(tool) || (tool.children?.length ?? 0) > 0 || (tool.nested ?? 0) > 0;

const writes = (tool: TranscriptTool): boolean =>
    tool.category === `edit` || tool.category === `delete` || tool.category === `move` || (tool.content ?? []).some((entry) => entry.type === `diff`);

// A shell call that carried a diff changed a file, whatever its category says; a browser tool is the web, whatever
// the backend filed it under.
const kindOf = (tool: TranscriptTool): RunKind => {
    if (delegates(tool)) {
        return `subagents`;
    }
    if (writes(tool)) {
        return `edits`;
    }
    if (tool.category === `fetch` || tool.name.toLowerCase().startsWith(`browser `)) {
        return `web`;
    }
    switch (tool.category) {
        case `execute`:
            return `commands`;
        case `search`:
            return `searches`;
        case `read`:
            return `reads`;
        default:
            return `other`;
    }
};

export const summarizeRun = (tools: readonly TranscriptTool[]): ToolRun | undefined => {
    if (tools.length === 0) {
        return undefined;
    }
    const counts = new Map<RunKind, number>();
    for (const tool of tools) {
        const kind = kindOf(tool);
        counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return {
        count: tools.length,
        kinds: RUN_KINDS.flatMap((kind) => {
            const count = counts.get(kind);
            return count === undefined ? [] : [{ kind, count }];
        }),
        failed: tools.filter((tool) => tool.status === `failed`).length,
        running: tools.some((tool) => tool.status === `pending` || tool.status === `in_progress`),
    };
};
