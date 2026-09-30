import { interactions, layoutShift, median } from "./measures";

// The numbers a reader feels, read off what the page recorded.

const event = (interaction: number, name: string, duration: number) => ({
    name,
    interaction,
    start: 0,
    duration,
    inputDelay: 1,
    processing: duration - 2,
    presentation: 1,
    target: `div.card`,
});

describe(`interactions`, () => {
    it(`counts each interaction once, by its longest event, longest first, and leaves out events of none`, () => {
        const found = interactions([event(1, `pointerdown`, 40), event(1, `click`, 320), event(2, `keydown`, 80), event(0, `mousemove`, 900)]);
        expect(found.map((interaction) => [interaction.id, interaction.duration])).toEqual([
            [1, 320],
            [2, 80],
        ]);
        expect(found[0]?.processing).toBe(318);
    });
});

describe(`layoutShift`, () => {
    it(`sums the shifts the reader did not cause`, () => {
        const shift = (value: number, recentInput: boolean) => ({ start: 0, value, recentInput, sources: [] });
        expect(layoutShift([shift(0.4071, false), shift(0.2264, false), shift(0.5, true)])).toBe(0.634);
    });
});

describe(`median`, () => {
    it(`is the middle run, or the mean of the middle two`, () => {
        expect(median([300, 100, 200])).toBe(200);
        expect(median([4, 1, 3, 2])).toBe(2.5);
        expect(median([])).toBe(0);
    });
});
