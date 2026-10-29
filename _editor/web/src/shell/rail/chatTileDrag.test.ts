import "@intentic/testing/dom";
import { effectScope } from "vue";
import type { ScreenPoint } from "../../workbench/window/floating";
import { containsPoint, GRAB, useChatTileDrag } from "./chatTileDrag";

// A short press stays the tile's click; a drag opens a window or docks right. The rail and Escape cancel both actions.

// A rail 48 wide down the left of a 1280 by 800 window; the window itself sits 100 by 50 into the screen.
const RAIL = { left: 0, top: 0, right: 48, bottom: 800 };
const SCREEN = { x: 100, y: 50 };

const pointer = (type: string, x: number, y: number, init: PointerEventInit = {}): PointerEvent =>
    new PointerEvent(type, { clientX: x, clientY: y, screenX: x + SCREEN.x, screenY: y + SCREEN.y, pointerType: `mouse`, button: 0, ...init });

const setup = (dockWidth = 320) => {
    const drops: ScreenPoint[] = [];
    const scope = effectScope();
    const docks: string[] = [];
    const drag = scope.run(() => useChatTileDrag({
        rail: () => RAIL,
        dockWidth: () => dockWidth,
        dock: () => docks.push(`right`),
        drop: (at) => drops.push(at),
    }))!;
    // The click a release would land as; counted only if nothing swallowed it on the way.
    const clicks: MouseEvent[] = [];
    const tile = document.createElement(`a`);
    document.body.append(tile);
    tile.addEventListener(`click`, (event) => clicks.push(event));
    const release = (x: number, y: number): void => {
        window.dispatchEvent(pointer(`pointerup`, x, y));
        tile.dispatchEvent(new MouseEvent(`click`, { bubbles: true, cancelable: true }));
    };
    const stop = (): void => {
        scope.stop();
        tile.remove();
    };
    return { drag, drops, docks, clicks, release, stop };
};

const move = (x: number, y: number): boolean => window.dispatchEvent(pointer(`pointermove`, x, y));

it(`leaves a press that never travelled to the tile's own click`, () => {
    const { drag, drops, clicks, release, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120));
    move(26, 121);

    expect(drag.phase.value).toBe(`pressed`);
    expect(drag.dragging.value).toBe(false);

    release(26, 121);
    expect(drops).toEqual([]);
    expect(clicks).toHaveLength(1);
    stop();
});

it(`opens the window where the tile was let go outside the rail, grabbed by its title bar`, () => {
    const { drag, drops, clicks, release, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120));
    move(30, 124);
    expect(drag.phase.value).toBe(`rail`);

    move(600, 300);
    expect(drag.phase.value).toBe(`out`);
    expect(drag.pointer.value).toEqual({ x: 600, y: 300 });

    release(600, 300);
    expect(drops).toEqual([{ left: 600 + SCREEN.x - GRAB.x, top: 300 + SCREEN.y - GRAB.y }]);
    // The release is the drop, not a visit to /chat.
    expect(clicks).toHaveLength(0);
    expect(drag.phase.value).toBe(`idle`);
    stop();
});

it(`counts past the window's own edge as outside the rail`, () => {
    const { drag, drops, release, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120));
    move(-80, 200);
    expect(drag.phase.value).toBe(`out`);

    release(-80, 200);
    expect(drops).toHaveLength(1);
    stop();
});

it(`puts the tile back when it is let go over the rail`, () => {
    const { drag, drops, clicks, release, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120));
    move(600, 300);
    move(20, 400);
    expect(drag.phase.value).toBe(`rail`);

    release(20, 400);
    expect(drops).toEqual([]);
    expect(clicks).toHaveLength(0);
    stop();
});

it(`cancels on Escape, and swallows the release that follows`, () => {
    const { drag, drops, clicks, release, stop } = setup();
    const heard: KeyboardEvent[] = [];
    const listener = (event: KeyboardEvent): void => void heard.push(event);
    document.addEventListener(`keydown`, listener);
    drag.press(pointer(`pointerdown`, 24, 120));
    move(600, 300);

    document.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true, cancelable: true }));
    expect(drag.dragging.value).toBe(false);
    // Only the drag heard it: whatever sits under the pointer keeps its own Escape for another time.
    expect(heard).toHaveLength(0);

    move(620, 320);
    expect(drag.dragging.value).toBe(false);
    release(620, 320);
    expect(drops).toEqual([]);
    expect(clicks).toHaveLength(0);
    document.removeEventListener(`keydown`, listener);
    stop();
});

it(`ignores a touch, a right button and a modified press`, () => {
    const { drag, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120, { pointerType: `touch` }));
    drag.press(pointer(`pointerdown`, 24, 120, { button: 2 }));
    drag.press(pointer(`pointerdown`, 24, 120, { ctrlKey: true }));

    expect(drag.phase.value).toBe(`idle`);
    stop();
});

it(`tells the rail from the rest by the rail's own box`, () => {
    expect(containsPoint(10, 10, RAIL)).toBe(true);
    expect(containsPoint(48, 10, RAIL)).toBe(false);
    expect(containsPoint(10, 900, RAIL)).toBe(false);
    expect(containsPoint(10, 10, undefined)).toBe(false);
});

it(`docks on the right without opening a window or following the tile's link`, () => {
    const { drag, drops, docks, clicks, release, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120));
    move(window.innerWidth - 100, 300);
    expect(drag.phase.value).toBe(`dock`);
    expect(drag.dragging.value).toBe(true);
    expect(drag.dockBox.value).toEqual({ left: window.innerWidth - 320, top: 0, right: window.innerWidth, bottom: window.innerHeight });
    release(window.innerWidth - 100, 300);
    expect(docks).toEqual([`right`]);
    expect(drops).toEqual([]);
    expect(clicks).toHaveLength(0);
    expect(drag.phase.value).toBe(`idle`);
    stop();
});

it(`switches immediately at the dock boundary and floats beyond the viewport`, () => {
    const { drag, release, drops, docks, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120));
    const edge = window.innerWidth - 320;
    move(edge - 1, 300);
    expect(drag.phase.value).toBe(`out`);
    move(edge, 300);
    expect(drag.phase.value).toBe(`dock`);
    move(window.innerWidth, 300);
    expect(drag.phase.value).toBe(`out`);
    move(edge, -1);
    expect(drag.phase.value).toBe(`out`);
    move(edge, window.innerHeight);
    expect(drag.phase.value).toBe(`out`);
    release(edge, window.innerHeight);
    expect(drops).toEqual([{ left: edge + SCREEN.x - GRAB.x, top: window.innerHeight + SCREEN.y - GRAB.y }]);
    expect(docks).toEqual([]);
    stop();
});

it(`uses the release position when it crosses from the middle to the dock target`, () => {
    const { drag, docks, drops, release, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120));
    move(500, 300);
    release(window.innerWidth - 100, 300);
    expect(docks).toEqual([`right`]);
    expect(drops).toEqual([]);
    stop();
});

it(`uses the release position when it crosses from the dock target to the middle`, () => {
    const { drag, docks, drops, release, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120));
    move(window.innerWidth - 100, 300);
    release(500, 300);
    expect(docks).toEqual([]);
    expect(drops).toEqual([{ left: 500 + SCREEN.x - GRAB.x, top: 300 + SCREEN.y - GRAB.y }]);
    stop();
});

it(`cancels docking on Escape and swallows the release`, () => {
    const { drag, docks, drops, clicks, release, stop } = setup();
    drag.press(pointer(`pointerdown`, 24, 120));
    move(window.innerWidth - 100, 300);
    document.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape`, bubbles: true, cancelable: true }));
    release(window.innerWidth - 100, 300);
    expect(docks).toEqual([]);
    expect(drops).toEqual([]);
    expect(clicks).toHaveLength(0);
    stop();
});

it(`leaves half the available width for the middle target when the stored chat width is large`, () => {
    const { drag, stop } = setup(window.innerWidth * 2);
    drag.press(pointer(`pointerdown`, 24, 120));
    expect(drag.dockBox.value).toEqual({ left: (window.innerWidth + RAIL.right) / 2, top: 0, right: window.innerWidth, bottom: window.innerHeight });
    stop();
});
