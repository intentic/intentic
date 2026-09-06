import { expect, test } from "vitest";
import { pictureRect, viewportCoords } from "./viewportCoords";

// The remote viewport both screencast surfaces map onto (screencast.ts VIEW_WIDTH/VIEW_HEIGHT): 8:5.
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
 * centred column with black either side, and measuring the PANE instead of that column drags every x toward
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
    // Half size: a click 100px in is 200 remote px.
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

// The same pane, asked the other question: where on it does something the remote page reported get painted?
const placed = (box: { left: number; top: number; width: number; height: number }, rect: { x: number; y: number; width: number; height: number }) =>
    pictureRect(
        { getBoundingClientRect: () => ({ ...box, right: box.left + box.width, bottom: box.top + box.height }) } as HTMLElement,
        WIDTH,
        HEIGHT,
        rect,
    );

/* WHERE THE DROP-DOWN MENU GOES. A <select> is reported in the page's own coordinates and the menu has to open
 * over it, so this is viewportCoords run backwards, and it has to letterbox identically or the menu drifts off
 * the control that opened it, by exactly the half-letterbox the forward rule exists to subtract. */
test("a rect from the page lands on the picture, letterbox and all", () => {
    // One-for-one pane: the control is where it says it is.
    expect(placed({ left: 0, top: 0, width: WIDTH, height: HEIGHT }, { x: 100, y: 60, width: 200, height: 40 })).toEqual({
        left: 100,
        top: 60,
        width: 200,
        height: 40,
    });
    // Twice as wide: the picture is a centred 1280-wide column, so everything shifts by the 640px bar.
    expect(placed({ left: 0, top: 0, width: 2560, height: HEIGHT }, { x: 100, y: 60, width: 200, height: 40 })).toEqual({
        left: 740,
        top: 60,
        width: 200,
        height: 40,
    });
    // Half size: the control is half as big and half as far in, like everything else in the picture.
    expect(placed({ left: 0, top: 0, width: WIDTH / 2, height: HEIGHT / 2 }, { x: 100, y: 60, width: 200, height: 40 })).toEqual({
        left: 50,
        top: 30,
        width: 100,
        height: 20,
    });
});

/* The round trip, which is the property that actually matters: click a control, and the menu drawn from what
 * the page reports about it must come back to the pixels that were clicked. */
test("a click and the rect it lands in agree with each other", () => {
    const box = { left: 240, top: 96, width: 1920, height: 1000 };
    const control = { x: 400, y: 300, width: 160, height: 32 };
    const painted = placed(box, control);
    // Aim at the middle of where the menu says the control is, and the page is told the middle of the control.
    const clicked = at(box, box.left + painted.left + painted.width / 2, box.top + painted.top + painted.height / 2);
    expect(clicked).toEqual({ x: control.x + control.width / 2, y: control.y + control.height / 2 });
});

test("a pane with no area yet places nothing rather than dividing by zero", () => {
    expect(placed({ left: 0, top: 0, width: 0, height: 0 }, { x: 10, y: 10, width: 10, height: 10 })).toEqual({
        left: 0,
        top: 0,
        width: 0,
        height: 0,
    });
});
