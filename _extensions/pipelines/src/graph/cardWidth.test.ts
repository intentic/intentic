import type { PipelineJob } from "@intentic/sandbox-contract";
import { CARD_MAX_WIDTH, CARD_MIN_WIDTH, columnWidths, type MeasureText } from "./cardWidth";
import { pipelineDag, pipelineStages } from "./pipelineDag";
import { formatDuration } from "../statusVisual";

// Pins that a column is as wide as its widest row, shared by every card in it, within the card's bounds.

// One px per character keeps the arithmetic readable.
const perChar: MeasureText = (text) => text.length;

const job = (name: string, needs: string[], extra: Partial<PipelineJob> = {}): PipelineJob => ({ name, status: `success`, needs, ...extra });

const widthsOf = (jobs: PipelineJob[], recurring = new Map<string, number>(), measure = perChar): Map<number, number> =>
    columnWidths(pipelineDag(pipelineStages(jobs)).nodes, recurring, measure);

describe(`columnWidths`, () => {
    test(`a column of short names takes the narrowest card`, () => {
        expect(widthsOf([job(`a`, []), job(`b`, [`a`])])).toEqual(new Map([[0, CARD_MIN_WIDTH], [1, CARD_MIN_WIDTH]]));
    });

    test(`a column grows to its widest row, duration and streak counted, and every card in it shares that width`, () => {
        const wide = `x`.repeat(40);
        const duration = formatDuration(65) ?? ``;
        const jobs = [job(`root`, []), job(wide, [`root`], { durationSeconds: 65 }), job(`short`, [`root`], { matrix: `m` })];
        const plain = widthsOf(jobs).get(1) ?? 0;
        // Chrome, name, gap, duration, slack.
        expect(plain).toBe(46 + 40 + 8 + duration.length + 2);
        expect(widthsOf(jobs, new Map([[wide, 3]])).get(1)).toBe(plain + 8 + 8 + `×3`.length);
        expect(widthsOf(jobs).get(0)).toBe(CARD_MIN_WIDTH);
    });

    test(`a name past the widest card is capped, left to truncate`, () => {
        expect(widthsOf([job(`y`.repeat(400), [])]).get(0)).toBe(CARD_MAX_WIDTH);
    });
});
