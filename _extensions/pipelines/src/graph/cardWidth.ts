import type { DagNode } from "@intentic/extension-ui";
import type { PipelineJob } from "@intentic/sandbox-contract";
import { jobLabel, type PipelineJobCluster, stageOfNode } from "./pipelineDag";
import { formatDuration } from "../statusVisual";

// A column is as wide as its widest row needs, not one width for every card: most job names fill half of a 192px
// card, and a long run's width is that waste times its column count. Every card in a column shares the column's width,
// so the gutter between two columns stays one straight band for the elbows to turn in.

// Width of a string in px as one of the row's three texts: the name, the duration, the failing-streak badge.
export type MeasureText = (text: string, size: `label` | `meta` | `badge`) => number;

// Narrowest card: a two-letter job still reads as a card, not a chip. Widest: past it the name truncates, its whole
// text on the tooltip.
export const CARD_MIN_WIDTH = 120;
export const CARD_MAX_WIDTH = 192;

// The row's fixed parts, mirroring PipelineDagGraph's row: pl-3, the 14px status icon, gap-2, pr-2.5, and the card's
// two 1px borders.
const ROW_CHROME = 12 + 14 + 8 + 10 + 2;
const GAP = 8;
// The streak badge's px-1 on both sides.
const BADGE_PAD = 8;
// Subpixel rounding: a name one pixel short of its box truncates for nothing.
const SLACK = 2;

const rowWidth = (job: PipelineJob, streak: number | undefined, measure: MeasureText): number => {
    const duration = formatDuration(job.durationSeconds);
    return (
        ROW_CHROME +
        measure(jobLabel(job.name), `label`) +
        (streak ? GAP + BADGE_PAD + measure(`×${streak}`, `badge`) : 0) +
        (duration === undefined ? 0 : GAP + measure(duration, `meta`))
    );
};

// Column index → the width every card in it takes.
export const columnWidths = (
    nodes: readonly DagNode<PipelineJobCluster>[],
    recurring: ReadonlyMap<string, number>,
    measure: MeasureText,
): Map<number, number> => {
    const widths = new Map<number, number>();
    for (const node of nodes) {
        const column = stageOfNode(node.id);
        const widest = Math.max(...node.data.jobs.map((member) => rowWidth(member.job, recurring.get(member.job.name), measure)));
        widths.set(column, Math.max(widths.get(column) ?? 0, widest));
    }
    for (const [column, width] of widths) {
        widths.set(column, Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, Math.ceil(width + SLACK))));
    }
    return widths;
};

// Where no canvas exists (a test, a server render): an average glyph is a little over half the font size wide.
export const estimateText: MeasureText = (text, size) => text.length * (size === `label` ? 11 : 10) * 0.56;
