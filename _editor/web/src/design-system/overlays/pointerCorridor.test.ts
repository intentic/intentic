import { inCorridor } from "@intentic/ui";

// The corridor a hover menu keeps itself up for: the triangle from where the pointer left its trigger to the panel's
// facing edge. Pinned on the geometry of the rail's top-left switcher: a 44px tile and the panel 8px to its right.

const panel = { left: 56, top: 4, right: 344, bottom: 404 };
// Out of the tile's right edge, halfway down it.
const right = { x: 48, y: 26 };
// Out of the tile's bottom edge, toward the rail below it.
const below = { x: 30, y: 48 };

it(`holds a pointer heading straight for the panel, at any row`, () => {
    expect(inCorridor({ x: 52, y: 26 }, right, panel)).toBe(true);
    expect(inCorridor({ x: 54, y: 300 }, right, panel)).toBe(true);
    expect(inCorridor({ x: 40, y: 120 }, below, panel)).toBe(true);
});

it(`lets go of a pointer that turned away from it`, () => {
    // Down the rail, under the tile: nowhere near the panel.
    expect(inCorridor({ x: 30, y: 200 }, below, panel)).toBe(false);
    // Back left, past where it left.
    expect(inCorridor({ x: 20, y: 26 }, right, panel)).toBe(false);
    // Up and out of the window's corner.
    expect(inCorridor({ x: 50, y: -40 }, right, panel)).toBe(false);
});

it(`forgives the first wobble at the exit itself`, () => {
    expect(inCorridor({ x: 47, y: 27 }, right, panel)).toBe(true);
});

it(`counts a pointer already over the panel as there`, () => {
    expect(inCorridor({ x: 100, y: 100 }, { x: 100, y: 50 }, panel)).toBe(true);
});
