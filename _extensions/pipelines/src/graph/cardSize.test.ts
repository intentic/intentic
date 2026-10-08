import type { PipelineJob } from "@intentic/sandbox-contract";
import { CARD_MAX_WIDTH, CARD_MIN_WIDTH, columnWidths, type MeasureText, NAME_LINE, nameLines, ROW_CHROME, rowHeight } from "./cardSize";
import { pipelineDag, pipelineStages } from "./pipelineDag";
import { formatDuration } from "../statusVisual";

// Pins that a column is as wide as its widest name (or metadata line), shared by every card in it, within the card's
// bounds; and that a name too long for its card wraps to a second line instead of widening it.

// One px per character keeps the arithmetic readable.
const perChar: MeasureText = (text) => text.length;

const job = (name: string, needs: string[], extra: Partial<PipelineJob> = {}): PipelineJob => ({ name, status: `success`, needs, ...extra });

const widthsOf = (jobs: PipelineJob[], recurring = new Map<string, number>()): Map<number, number> =>
    columnWidths(pipelineDag(pipelineStages(jobs)).nodes, recurring, perChar);

describe(`columnWidths`, () => {
    test(`a column of short names takes the narrowest card`, () => {
        expect(widthsOf([job(`a`, []), job(`b`, [`a`])])).toEqual(
            new Map([
                [0, CARD_MIN_WIDTH],
                [1, CARD_MIN_WIDTH],
            ]),
        );
    });

    test(`a column grows to its widest name, and every card in it shares that width`, () => {
        const wide = `x`.repeat(90);
        const jobs = [job(`root`, []), job(wide, [`root`]), job(`short`, [`root`], { matrix: `m` })];
        // Chrome, name, slack.
        expect(widthsOf(jobs).get(1)).toBe(ROW_CHROME + 90 + 2);
        expect(widthsOf(jobs).get(0)).toBe(CARD_MIN_WIDTH);
    });

    test(`duration and streak sit on their own line, so they widen a card only when that line is the longer one`, () => {
        const duration = formatDuration(65) ?? ``;
        const short = [job(`root`, []), job(`n`.repeat(90), [`root`], { durationSeconds: 65 })];
        expect(widthsOf(short, new Map([[`n`.repeat(90), 3]])).get(1)).toBe(ROW_CHROME + 90 + 2);
        const longMeta = [job(`root`, []), job(`n`, [`root`], { durationSeconds: 65 })];
        expect(widthsOf(longMeta, new Map([[`n`, 3]])).get(1)).toBe(Math.max(CARD_MIN_WIDTH, ROW_CHROME + 8 + 2 + 6 + duration.length + 2));
    });

    test(`a name past the widest card is capped, left to wrap`, () => {
        expect(widthsOf([job(`y`.repeat(400), [])]).get(0)).toBe(CARD_MAX_WIDTH);
    });
});

describe(`rowHeight`, () => {
    test(`a name that fits takes one line, one that does not takes two`, () => {
        expect(nameLines(job(`a`.repeat(20), []), CARD_MAX_WIDTH, perChar)).toBe(1);
        expect(nameLines(job(`a`.repeat(200), []), CARD_MAX_WIDTH, perChar)).toBe(2);
    });

    test(`the metadata line adds height only when there is something on it`, () => {
        const plain = rowHeight(job(`a`, []), new Map(), CARD_MAX_WIDTH, perChar);
        const timed = rowHeight(job(`a`, [], { durationSeconds: 5 }), new Map(), CARD_MAX_WIDTH, perChar);
        const wrapped = rowHeight(job(`a`.repeat(200), [], { durationSeconds: 5 }), new Map(), CARD_MAX_WIDTH, perChar);
        expect(timed).toBeGreaterThan(plain);
        expect(wrapped - timed).toBe(NAME_LINE);
    });
});
