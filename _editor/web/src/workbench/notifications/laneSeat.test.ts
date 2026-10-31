import { LANE_GAP_PX, type LaneBox, laneSeat } from "./laneSeat";

const VIEWPORT = { width: 1440, height: 900 };
const RAIL: LaneBox = { left: 0, right: 56, top: 0, bottom: 900 };
const STATUS_BAR: LaneBox = { left: 56, right: 1440, top: 871, bottom: 900 };

it(`stands one gap right of the rail and one gap above the status bar`, () => {
    expect(laneSeat([RAIL], [STATUS_BAR], VIEWPORT, 352)).toEqual({ left: 56 + LANE_GAP_PX, bottom: 29 + LANE_GAP_PX });
});

it(`takes the window's own corner where there is no rail and no status bar`, () => {
    expect(laneSeat([], [], VIEWPORT, 352)).toEqual({ left: LANE_GAP_PX, bottom: LANE_GAP_PX });
});

// The chat roster's New agent sits at the foot of the lane's column: the lane stands on it, not over it.
it(`climbs above a floor under its column`, () => {
    const newAgent: LaneBox = { left: 56, right: 376, top: 809, bottom: 871 };
    expect(laneSeat([RAIL], [STATUS_BAR, newAgent], VIEWPORT, 352).bottom).toBe(900 - 809 + LANE_GAP_PX);
});

// A composer centred in a wide column never reaches the lane, so it must not lift it.
it(`ignores a floor beside its column`, () => {
    const composer: LaneBox = { left: 508, right: 1308, top: 747, bottom: 835 };
    expect(laneSeat([RAIL], [STATUS_BAR, composer], VIEWPORT, 352).bottom).toBe(29 + LANE_GAP_PX);
});

it(`ignores a floor wholly in the upper half, a wall in the right half, and anything with no box`, () => {
    const header: LaneBox = { left: 56, right: 1440, top: 0, bottom: 40 };
    const rightColumn: LaneBox = { left: 1100, right: 1440, top: 0, bottom: 900 };
    const hidden: LaneBox = { left: 0, right: 0, top: 0, bottom: 0 };
    expect(laneSeat([RAIL, rightColumn, hidden], [STATUS_BAR, header, hidden], VIEWPORT, 352)).toEqual({
        left: 56 + LANE_GAP_PX,
        bottom: 29 + LANE_GAP_PX,
    });
});

// A docked terminal is a floor: the lane stands on its top edge, however tall it is dragged.
it(`stands on a docked terminal's top edge, even one reaching into the upper half`, () => {
    const terminal: LaneBox = { left: 56, right: 1440, top: 300, bottom: 871 };
    expect(laneSeat([RAIL], [STATUS_BAR, terminal], VIEWPORT, 352).bottom).toBe(900 - 300 + LANE_GAP_PX);
});
