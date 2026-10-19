import { reviewListMode } from "./reviewRoom";

// Pins where a review puts its file list for the room it has: beside the diff when it fits, folded into one switcher row
// when it does not, and gone when that row would have nothing to switch between.

describe(`where the review's file list goes`, () => {
    it(`stands beside the diff on a roomy review, however few files`, () => {
        expect([reviewListMode(false, 1, 1), reviewListMode(false, 12, 3)]).toEqual([`side`, `side`]);
    });

    it(`folds into a switcher row over the diff on a narrow review with files to switch between`, () => {
        expect(reviewListMode(true, 3, 1)).toBe(`switcher`);
    });

    it(`keeps the row for a single file that still has narrowings to offer (conflicts, history)`, () => {
        expect(reviewListMode(true, 1, 2)).toBe(`switcher`);
    });

    it(`draws no list at all for a single file on a narrow review: the diff's toolbar already names it`, () => {
        expect(reviewListMode(true, 1, 1)).toBe(`none`);
    });
});
