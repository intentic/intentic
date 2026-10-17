import type { AgentEvent } from "../events/agent-events.js";
import type { TranscriptRow } from "../events/transcript.js";

// What the chat draws inline, on the bubble that showed it, rather than as a card that waits for an answer: a page the
// agent showed (show_page) and a code review's findings. Each has an id, and one shown again under its id is a redraw
// (a page redrawn, a review re-reported with its fixes applied), so the earlier row folds to a line.

export type InlineEvent = Extract<AgentEvent, { kind: "page" | "review" }>;

const drawnOf = (row: TranscriptRow, kind: InlineEvent["kind"]): { readonly id: string; readonly superseded?: boolean | undefined } | undefined =>
    kind === "page" ? row.page : row.review;

// The latest row still drawing this one in full, folded now that its redraw stands below; undefined when none does.
export const supersedeEarlier = (rows: TranscriptRow[], event: InlineEvent): number | undefined => {
    const id = event.kind === "page" ? event.page.id : event.review.id;
    const index = rows.findLastIndex((row) => {
        const drawn = drawnOf(row, event.kind);
        return drawn !== undefined && drawn.id === id && drawn.superseded !== true;
    });
    const row = rows[index];
    if (row === undefined) {
        return undefined;
    }
    if (event.kind === "page" && row.page !== undefined) {
        row.page = { ...row.page, superseded: true };
    } else if (event.kind === "review" && row.review !== undefined) {
        row.review = { ...row.review, superseded: true };
    }
    return index;
};

export const drawInline = (row: TranscriptRow, event: InlineEvent): void => {
    if (event.kind === "page") {
        row.page = event.page;
    } else {
        row.review = event.review;
    }
};
