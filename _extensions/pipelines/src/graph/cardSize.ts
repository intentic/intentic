import type { DagNode } from "@intentic/extension-ui";
import type { PipelineJob } from "@intentic/sandbox-contract";
import { jobName, type PipelineJobCluster, stageOfNode } from "./pipelineDag";
import { formatDuration, STATUS_TONE } from "../statusVisual";

// A long run is width-bound and has height to spare, so a job row stacks what it says instead of lining it up:
//   release              the calls it came through, small, when it is a called workflow's job
//   linux-build          its own name, wrapping to a second line rather than widening the card
//   ✓ ×3 11m 18s         its status, failing streak and duration (or the status word when it has no clock)
// A column is then as wide as the longest of those lines in it, up to CARD_MAX_WIDTH; every card in a column shares
// that width, so the gutter between two columns stays one straight band for the elbows to turn in. Each line's height
// is set from here on the row too, so the box the layout places is the box the rows fill.

// Width of a string in px as one of the row's texts: the name, the caller above it, the status line's text, the
// failing-streak badge.
export type MeasureText = (text: string, size: `label` | `caller` | `meta` | `badge`) => number;

// Narrowest card: a short job still reads as a card, not a chip. Widest: past it a name wraps, and past two lines it
// ends in an ellipsis with the whole name on its tooltip.
export const CARD_MIN_WIDTH = 96;
export const CARD_MAX_WIDTH = 152;

// The row's fixed width, mirroring PipelineDagGraph's row: pl-2.5, pr-2 and the card's two 1px borders. What is left
// is the text column every line shares.
export const ROW_CHROME = 10 + 8 + 2;
// The status line: its icon at text-xs, then gap-1 between its parts; the streak badge's px-1 on both sides.
const STATUS_ICON = 12;
const GAP = 4;
const BADGE_PAD = 8;
// Subpixel rounding: a name one pixel short of its box wraps for nothing.
const SLACK = 2;

// Line boxes, px, set on the row's lines as their line height.
export const CALLER_LINE = 13;
export const NAME_LINE = 14;
export const STATUS_LINE = 14;
// The row's own top and bottom air, together.
const ROW_PAD_Y = 8;

// What a row's status line says beside its icon.
export interface JobStatusLine {
    readonly streak: number | undefined;
    // The duration, or for a job with no clock (skipped, queued) its status in a word.
    readonly text: string;
}

export const jobStatusLine = (job: PipelineJob, recurring: ReadonlyMap<string, number>): JobStatusLine => ({
    streak: recurring.get(job.name) || undefined,
    text: formatDuration(job.durationSeconds) ?? STATUS_TONE[job.status].label,
});

const statusWidth = (line: JobStatusLine, measure: MeasureText): number =>
    STATUS_ICON + GAP + (line.streak === undefined ? 0 : BADGE_PAD + measure(`×${line.streak}`, `badge`) + GAP) + measure(line.text, `meta`);

// The text column a row wants: the longest of its lines, its name taken on one line.
const textWidth = (job: PipelineJob, recurring: ReadonlyMap<string, number>, measure: MeasureText): number => {
    const { caller, title } = jobName(job.name);
    return Math.max(
        measure(title, `label`),
        caller === undefined ? 0 : measure(caller, `caller`),
        statusWidth(jobStatusLine(job, recurring), measure),
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
        const widest = Math.max(...node.data.jobs.map((member) => ROW_CHROME + textWidth(member.job, recurring, measure)));
        widths.set(column, Math.max(widths.get(column) ?? 0, widest));
    }
    for (const [column, width] of widths) {
        widths.set(column, Math.min(CARD_MAX_WIDTH, Math.max(CARD_MIN_WIDTH, Math.ceil(width + SLACK))));
    }
    return widths;
};

// Lines a name takes in a card this wide: one if it fits, else two, where the second ends in an ellipsis if need be.
export const nameLines = (job: PipelineJob, cardWidth: number, measure: MeasureText): 1 | 2 =>
    measure(jobName(job.name).title, `label`) + SLACK <= cardWidth - ROW_CHROME ? 1 : 2;

// A row's height in a card this wide: its caller line if it has one, its name's lines, its status line, its own air.
export const rowHeight = (job: PipelineJob, cardWidth: number, measure: MeasureText): number =>
    ROW_PAD_Y + (jobName(job.name).caller === undefined ? 0 : CALLER_LINE) + nameLines(job, cardWidth, measure) * NAME_LINE + STATUS_LINE;

// Where nothing can be laid out (a test, a server render): an average glyph is a little over half the font size wide.
export const estimateText: MeasureText = (text, size) => text.length * (size === `label` ? 11 : 10) * 0.56;
