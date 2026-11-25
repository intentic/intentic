import { NARROW_HYSTERESIS_REM } from "@intentic/ui";
import { CAPACITY_RAIL_PX, PANE_COMFORT_PX } from "../../../../chat/panel/capacity/chatCapacity";
import { ICON_RAIL_SCREEN_PX } from "../../../../../workbench/window/iconRailWidth";
import { DEFAULT_CHAT_WIDTH } from "../../../../../workbench/window/useLayout";
import { boardLayout, cardFit, footOf, LOUD, ROOMY_BOARD_REM } from "../boardGrid";

// Pins how the board lays its lanes out: by its width, and by which lanes are empty, so an empty lane gives its column
// to the lanes with something to read.

const quiet = (...lanes: (keyof typeof LOUD)[]) => ({ ...LOUD, ...Object.fromEntries(lanes.map((lane) => [lane, true])) });

describe(`boardLayout`, () => {
    it(`stacks a narrow board whatever its lanes hold`, () => {
        expect(boardLayout(true, true, LOUD)).toEqual({ kind: `stacked` });
        expect(boardLayout(true, false, quiet(`attention`, `active`))).toEqual({ kind: `stacked` });
    });

    it(`lays a board with every lane full out by its width`, () => {
        expect(boardLayout(false, false, LOUD)).toEqual({ kind: `three` });
        expect(boardLayout(false, true, LOUD)).toEqual({ kind: `paired` });
    });

    it(`pairs Attention and Active in one column once either is empty, at any width`, () => {
        expect(boardLayout(false, false, quiet(`attention`))).toEqual({ kind: `paired` });
        expect(boardLayout(false, false, quiet(`active`))).toEqual({ kind: `paired` });
        expect(boardLayout(false, true, quiet(`attention`))).toEqual({ kind: `paired` });
    });

    it(`tucks an empty Finished under Active, giving Attention a column of its own`, () => {
        expect(boardLayout(false, false, quiet(`finished`))).toEqual({ kind: `tucked` });
        expect(boardLayout(false, true, quiet(`finished`))).toEqual({ kind: `tucked` });
    });

    it(`hands the board to the one lane holding anything`, () => {
        expect(boardLayout(false, false, quiet(`attention`, `active`))).toEqual({ kind: `ledger`, wide: `finished` });
        expect(boardLayout(false, false, quiet(`attention`, `finished`))).toEqual({ kind: `ledger`, wide: `active` });
        expect(boardLayout(false, true, quiet(`active`, `finished`))).toEqual({ kind: `ledger`, wide: `attention` });
    });

    it(`keeps three columns on a roomy board whatever its lanes hold, since none of them is cramped`, () => {
        expect(boardLayout(false, false, quiet(`attention`), true)).toEqual({ kind: `three` });
        expect(boardLayout(false, false, quiet(`attention`, `active`), true)).toEqual({ kind: `three` });
        expect(boardLayout(true, true, quiet(`finished`), true)).toEqual({ kind: `stacked` });
    });

    it(`keeps the width's layout on a board with nothing in any lane`, () => {
        expect(boardLayout(false, false, quiet(`attention`, `active`, `finished`))).toEqual({ kind: `three` });
        expect(boardLayout(false, true, quiet(`attention`, `active`, `finished`))).toEqual({ kind: `paired` });
    });
});

// How much of a card a squeezed board draws, by the narrowest width it is under: each step keeps less, never more.
describe(`footOf`, () => {
    it(`stands the bottom-left corner under whichever lane ends the first column, and nowhere on a stacked board`, () => {
        expect(footOf({ kind: `three` })).toBe(`attention`);
        expect(footOf({ kind: `tucked` })).toBe(`attention`);
        expect(footOf({ kind: `paired` })).toBe(`active`);
        expect(footOf({ kind: `ledger`, wide: `finished` })).toBe(`finished`);
        expect(footOf({ kind: `stacked` })).toBeUndefined();
    });
});

describe(`cardFit`, () => {
    it(`keeps the full card until the board is under its compact width`, () => {
        expect(cardFit(false, false, false)).toBe(`full`);
        expect(cardFit(true, false, false)).toBe(`compact`);
    });

    it(`steps down to mini and then to the tile as the board narrows`, () => {
        expect(cardFit(true, true, false)).toBe(`mini`);
        expect(cardFit(true, true, true)).toBe(`tile`);
    });
});

// A 4K screen at 150% (3840px / 1.5) keeps the roomy board's three lanes beside a chat docked just wide enough for its
// Usage left rail (railFitsBeside: one pane at comfort width plus the rail). The board's own chrome, measured in the
// demo: the lane grid's padding (lg:p-6, 48px), the scroller's stable gutter (10px) and the chat's seam (1px). The board
// must clear the roomy width by the hysteresis too, or one that once folded would never unfold again at that width.
describe(`the roomy board's width`, () => {
    it(`keeps three lanes on a 2560px screen beside a chat showing its usage rail`, () => {
        const screen = 3840 / 1.5;
        const chrome = 48 + 10 + 1;
        const board = screen - ICON_RAIL_SCREEN_PX - (PANE_COMFORT_PX + CAPACITY_RAIL_PX) - chrome;
        expect(board).toBeGreaterThanOrEqual((ROOMY_BOARD_REM + NARROW_HYSTERESIS_REM) * 16);
    });
});

// A 1600px screen beside the chat at its default width keeps three lanes, whatever they hold. Until 2026-11-23 the roomy
// width was 90rem, so that board (69.9rem, measured in the demo) folded into two wide columns whenever one lane was empty,
// and the owner found three columns arriving too late. The board's element is what is measured, so only the chat's seam
// (1px) comes off besides the rail and the chat.
describe(`a laptop-sized board`, () => {
    it(`keeps three lanes on a 1600px screen beside the chat at its default width`, () => {
        const board = 1600 - ICON_RAIL_SCREEN_PX - DEFAULT_CHAT_WIDTH - 1;
        expect(board).toBeGreaterThanOrEqual((ROOMY_BOARD_REM + NARROW_HYSTERESIS_REM) * 16);
    });
});
