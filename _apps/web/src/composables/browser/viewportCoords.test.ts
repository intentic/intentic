import { expect, test } from "vitest";
import { viewportCoords } from "./viewportCoords";

// The remote viewport both screencast surfaces map onto (screencast.ts VIEW_WIDTH/VIEW_HEIGHT) — 8:5.
const WIDTH = 1280;
const HEIGHT = 800;

// A pane, and a click at a point inside it. Only the four fields the rule reads are stubbed.
const at = (box: { left: number; top: number; width: number; height: number }, clientX: number, clientY: number) => {
    const element = { getBoundingClientRect: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }) } as HTMLElement;
    return viewportCoords({ clientX, clientY } as MouseEvent, element, WIDTH, HEIGHT);
};

test("a pane of the remote shape maps one-for-one", () => {
    const box = { left: 0, top: 0, width: WIDTH, height: HEIGHT };
    expect(at(box, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(at(box, 640, 400)).toEqual({ x: 640, y: 400 });
    expect(at(box, WIDTH, HEIGHT)).toEqual({ x: WIDTH, y: HEIGHT });
});

/* THE BUG THIS RULE EXISTS FOR. The frame is object-contain'd, so in a pane wider than 8:5 it paints in a
 * centred column with black either side — and measuring the PANE instead of that column drags every x toward
 * the middle. Here the picture occupies 1280 of a 2560-wide pane: a click 640px in is its left edge, which the
 * old rule (clientX / paneWidth * 1280) called x=320, a third of the way into the page. */
test("a pane wider than the remote shape measures the picture, not the letterbox", () => {
    const box = { left: 0, top: 0, width: 2560, height: HEIGHT };
    expect(at(box, 640, 0)).toEqual({ x: 0, y: 0 });
    expect(at(box, 1280, 400)).toEqual({ x: 640, y: 400 });
    expect(at(box, 1920, HEIGHT)).toEqual({ x: WIDTH, y: HEIGHT });
});

test("a pane taller than the remote shape letterboxes the other way", () => {
    const box = { left: 0, top: 0, width: WIDTH, height: 1600 };
    expect(at(box, 640, 400)).toEqual({ x: 640, y: 0 });
    expect(at(box, 640, 800)).toEqual({ x: 640, y: 400 });
});

test("the pane's own offset on the page is subtracted", () => {
    // Scrolled down, sitting beside a rail: the same click is the same page coordinate.
    expect(at({ left: 240, top: 96, width: WIDTH, height: HEIGHT }, 240 + 100, 96 + 50)).toEqual({ x: 100, y: 50 });
});

test("scaled panes divide back out", () => {
    // Half size — a click 100px in is 200 remote px.
    expect(at({ left: 0, top: 0, width: WIDTH / 2, height: HEIGHT / 2 }, 100, 50)).toEqual({ x: 200, y: 100 });
});

test("a click in the letterbox belongs to the nearest edge, not to a coordinate off the page", () => {
    const box = { left: 0, top: 0, width: 2560, height: HEIGHT };
    expect(at(box, 0, 0)).toEqual({ x: 0, y: 0 });
    expect(at(box, 2560, HEIGHT)).toEqual({ x: WIDTH, y: HEIGHT });
});

test("a pane with no area yet maps to the origin rather than dividing by zero", () => {
    expect(at({ left: 0, top: 0, width: 0, height: 0 }, 10, 10)).toEqual({ x: 0, y: 0 });
});
