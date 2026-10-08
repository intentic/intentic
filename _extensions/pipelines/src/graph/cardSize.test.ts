import type { PipelineJob } from "@intentic/sandbox-contract";
import {
    CALLER_LINE,
    CARD_MAX_WIDTH,
    CARD_MIN_WIDTH,
    columnWidths,
    jobStatusLine,
    type MeasureText,
    NAME_LINE,
    nameLines,
    ROW_CHROME,
    rowHeight,
} from "./cardSize";
import { pipelineDag, pipelineStages } from "./pipelineDag";

// Pins that a column is as wide as the longest line in it (caller, name, status line), shared by every card in it,
// within the card's bounds; and that a row stacks its lines rather than lining them up.

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
        const wide = `x`.repeat(100);
        const jobs = [job(`root`, []), job(wide, [`root`]), job(`short`, [`root`], { matrix: `m` })];
        // Chrome, name, slack.
        expect(widthsOf(jobs).get(1)).toBe(ROW_CHROME + 100 + 2);
        expect(widthsOf(jobs).get(0)).toBe(CARD_MIN_WIDTH);
    });

    test(`a called workflow's job is as wide as its own name or its caller, not the two side by side`, () => {
        const caller = `c`.repeat(90);
        const title = `t`.repeat(70);
        expect(widthsOf([job(`${caller} / ${title}`, [])]).get(0)).toBe(ROW_CHROME + 90 + 2);
    });

    test(`the status line widens a card only when it is the longest line`, () => {
        const name = `n`.repeat(100);
        expect(widthsOf([job(name, [], { durationSeconds: 65 })], new Map([[name, 3]])).get(0)).toBe(ROW_CHROME + 100 + 2);
    });

    test(`a name past the widest card is capped, left to wrap`, () => {
        expect(widthsOf([job(`y`.repeat(400), [])]).get(0)).toBe(CARD_MAX_WIDTH);
    });
});

describe(`rows`, () => {
    test(`a name that fits takes one line, one that does not takes two`, () => {
        expect(nameLines(job(`a`.repeat(20), []), CARD_MAX_WIDTH, perChar)).toBe(1);
        expect(nameLines(job(`a`.repeat(200), []), CARD_MAX_WIDTH, perChar)).toBe(2);
    });

    test(`a caller adds its line above the name, and a wrapped name its second line`, () => {
        const plain = rowHeight(job(`a`, []), CARD_MAX_WIDTH, perChar);
        expect(rowHeight(job(`release / a`, []), CARD_MAX_WIDTH, perChar) - plain).toBe(CALLER_LINE);
        expect(rowHeight(job(`a`.repeat(200), []), CARD_MAX_WIDTH, perChar) - plain).toBe(NAME_LINE);
    });

    test(`the status line carries the duration, or the status in a word when the job has no clock`, () => {
        expect(jobStatusLine(job(`a`, [], { status: `skipped` }), new Map()).text).not.toBe(``);
        expect(jobStatusLine(job(`a`, [], { durationSeconds: 5 }), new Map([[`a`, 2]])).streak).toBe(2);
        expect(jobStatusLine(job(`a`, []), new Map([[`a`, 0]])).streak).toBeUndefined();
    });
});
