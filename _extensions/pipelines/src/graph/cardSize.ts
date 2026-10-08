import type { DagNode } from "@intentic/extension-ui";
import type { PipelineJob } from "@intentic/sandbox-contract";
import { jobLabel, type PipelineJobCluster, stageOfNode } from "./pipelineDag";
import { formatDuration } from "../statusVisual";

// A long run is width-bound and has height to spare, so a job row spends height to save width: its name on top, wrapping
// to a second line rather than widening the card, and what qualifies it (the failing streak, the duration) on a line of
// its own beneath. A column is then as wide as its widest name needs, up to CARD_MAX_WIDTH; every card in a column
// shares that width, so the gutter between two columns stays one straight band for the elbows to turn in.

// Width of a string in px as one of the row's three texts: the name, the duration, the failing-streak badge.
export type MeasureText = (text: string, size: `label` | `meta` | `badge`) => number;

// Narrowest card: a short job still reads as a card, not a chip. Widest: past it a name wraps, and past two lines it
// ends in an ellipsis with the whole name on its tooltip.
export const CARD_MIN_WIDTH = 104;
export const CARD_MAX_WIDTH = 152;

// The row's fixed width, mirroring PipelineDagGraph's row: pl-2.5, the 14px status icon, gap-1.5, pr-2, and the card's
// two 1px borders. What is left is the text column both lines share.
export const ROW_CHROME = 10 + 14 + 6 + 8 + 2;
const GAP = 6;
// The streak badge's px-1 on both sides.
const BADGE_PAD = 8;
// Subpixel rounding: a name one pixel short of its box wraps for nothing.
const SLACK = 2;

// Line boxes, px: the name at text-2xs leading-tight, the metadata at text-3xs; the row's own top and bottom air.
export const NAME_LINE = 14;
export const META_LINE = 13;
const ROW_PAD_Y = 9;
// A row stays a comfortable pointer target even with one short line in it.
const ROW_MIN_HEIGHT = 28;

// What the metadata line carries for a job, or nothing when it has neither.
export interface JobMeta {
    readonly streak: number | undefined;
    readonly duration: string | undefined;
}

export const jobMeta = (job: PipelineJob, recurring: ReadonlyMap<string, number>): JobMeta => ({
    streak: recurring.get(job.name) || undefined,
    duration: formatDuration(job.durationSeconds),
});

const hasMeta = (meta: JobMeta): boolean => meta.streak !== undefined || meta.duration !== undefined;

const metaWidth = (meta: JobMeta, measure: MeasureText): number =>
    (meta.streak === undefined ? 0 : BADGE_PAD + measure(`×${meta.streak}`, `badge`)) +
    (meta.streak !== undefined && meta.duration !== undefined ? GAP : 0) +
    (meta.duration === undefined ? 0 : measure(meta.duration, `meta`));

// The text column a row wants: its name on one line, or its metadata line if that is longer.
const textWidth = (job: PipelineJob, recurring: ReadonlyMap<string, number>, measure: MeasureText): number =>
    Math.max(measure(jobLabel(job.name), `label`), metaWidth(jobMeta(job, recurring), measure));

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
    measure(jobLabel(job.name), `label`) + SLACK <= cardWidth - ROW_CHROME ? 1 : 2;

// A row's height in a card this wide: its name's lines, its metadata line if it has one, and the row's own air.
export const rowHeight = (job: PipelineJob, recurring: ReadonlyMap<string, number>, cardWidth: number, measure: MeasureText): number =>
    Math.max(
        ROW_MIN_HEIGHT,
        ROW_PAD_Y + nameLines(job, cardWidth, measure) * NAME_LINE + (hasMeta(jobMeta(job, recurring)) ? META_LINE : 0),
    );

// Where nothing can be laid out (a test, a server render): an average glyph is a little over half the font size wide.
export const estimateText: MeasureText = (text, size) => text.length * (size === `label` ? 11 : 10) * 0.56;
