// What a finger on a phone or tablet does to a live browser. Each test is one gesture as the pointer events arrive,
// and the clicks, drags, scrolls and zooms it must become.
import { LONG_PRESS_MS, MULTI_TAP_MS, TAP_SLOP, touchGestures, type Point, type TouchHooks } from "./touchGestures";

type Said =
    | { readonly pointer: `move` | `down` | `up`; readonly at: Point; readonly button: number; readonly buttons: number; readonly clickCount: number }
    | { readonly scroll: readonly [number, number] }
    | { readonly zoom: `begin` | `pinch`; readonly at: Point; readonly spread: number };

const surface = (pan: (dx: number, dy: number) => readonly [number, number] = (dx, dy) => [dx, dy]) => {
    const said: Said[] = [];
    let clock = 0;
    let timer: { run: () => void; due: number } | undefined;
    const cursors: (Point | undefined)[] = [];
    const hooks: TouchHooks = {
        pointer: (action, at, button, buttons, clickCount) => said.push({ pointer: action, at, button, buttons, clickCount }),
        scroll: (dx, dy) => said.push({ scroll: [dx, dy] }),
        zoom: {
            begin: (x, y, spread) => said.push({ zoom: `begin`, at: { x, y }, spread }),
            pinch: (x, y, spread) => said.push({ zoom: `pinch`, at: { x, y }, spread }),
            pan,
        },
        bounds: () => ({ left: 0, top: 0, right: 400, bottom: 300 }),
        cursor: (at) => cursors.push(at),
        now: () => clock,
        later: (run, ms) => {
            const due = clock + ms;
            timer = { run, due };
            return () => {
                if (timer?.due === due) {
                    timer = undefined;
                }
            };
        },
    };
    const touch = touchGestures(hooks);
    const point = (id: number, x: number, y: number) => ({ pointerId: id, clientX: x, clientY: y, timeStamp: clock });
    return {
        said,
        cursors,
        touch,
        point,
        // Time passes; a long press due by then fires.
        wait: (ms: number) => {
            clock += ms;
            if (timer !== undefined && timer.due <= clock) {
                const { run } = timer;
                timer = undefined;
                run();
            }
        },
    };
};

const pointers = (said: readonly Said[]) => said.filter((entry) => `pointer` in entry);

describe("one finger", () => {
    test("a tap clicks where it landed", () => {
        const { said, touch, point } = surface();
        touch.down(point(1, 100, 80));
        touch.up(point(1, 102, 81));
        expect(said).toEqual([
            { pointer: `move`, at: { x: 100, y: 80 }, button: 0, buttons: 0, clickCount: 0 },
            { pointer: `down`, at: { x: 100, y: 80 }, button: 0, buttons: 1, clickCount: 1 },
            { pointer: `up`, at: { x: 100, y: 80 }, button: 0, buttons: 0, clickCount: 1 },
        ]);
    });

    // The second finger lands a little off; a double click is two presses on the same spot.
    test("a double tap double-clicks where the first tap did", () => {
        const { said, touch, point, wait } = surface();
        touch.down(point(1, 100, 80));
        touch.up(point(1, 100, 80));
        wait(MULTI_TAP_MS / 2);
        touch.down(point(2, 110, 90));
        touch.up(point(2, 110, 90));
        expect(said.slice(3)).toEqual([
            { pointer: `move`, at: { x: 100, y: 80 }, button: 0, buttons: 0, clickCount: 0 },
            { pointer: `down`, at: { x: 100, y: 80 }, button: 0, buttons: 1, clickCount: 2 },
            { pointer: `up`, at: { x: 100, y: 80 }, button: 0, buttons: 0, clickCount: 2 },
        ]);
    });

    test("a drag is a left-button drag from where the finger landed", () => {
        const { said, touch, point } = surface();
        touch.down(point(1, 50, 50));
        touch.move(point(1, 50 + TAP_SLOP + 5, 50));
        touch.move(point(1, 120, 60));
        touch.up(point(1, 120, 60));
        expect(said).toEqual([
            { pointer: `move`, at: { x: 50, y: 50 }, button: 0, buttons: 0, clickCount: 0 },
            { pointer: `down`, at: { x: 50, y: 50 }, button: 0, buttons: 1, clickCount: 1 },
            { pointer: `move`, at: { x: 65, y: 50 }, button: 0, buttons: 1, clickCount: 0 },
            { pointer: `move`, at: { x: 120, y: 60 }, button: 0, buttons: 1, clickCount: 0 },
            { pointer: `up`, at: { x: 120, y: 60 }, button: 0, buttons: 0, clickCount: 1 },
        ]);
    });

    test("a long press right-clicks, and lifting after it clicks nothing more", () => {
        const { said, touch, point, wait } = surface();
        touch.down(point(1, 30, 40));
        wait(LONG_PRESS_MS);
        touch.up(point(1, 30, 40));
        expect(said).toEqual([
            { pointer: `move`, at: { x: 30, y: 40 }, button: 2, buttons: 0, clickCount: 0 },
            { pointer: `down`, at: { x: 30, y: 40 }, button: 2, buttons: 2, clickCount: 1 },
            { pointer: `up`, at: { x: 30, y: 40 }, button: 2, buttons: 0, clickCount: 1 },
        ]);
    });

    // A cancelled touch (the OS took the gesture) must not leave the remote button down.
    test("a drag the system cancels lets go of the button", () => {
        const { said, touch, point } = surface();
        touch.down(point(1, 50, 50));
        touch.move(point(1, 90, 50));
        touch.cancel(point(1, 90, 50));
        expect(pointers(said).at(-1)).toEqual({ pointer: `up`, at: { x: 90, y: 50 }, button: 0, buttons: 0, clickCount: 1 });
    });
});

describe("two fingers", () => {
    test("moving together scrolls the page the way the fingers move it, and clicks nothing", () => {
        const { said, touch, point } = surface();
        touch.down(point(1, 100, 200));
        touch.down(point(2, 200, 200));
        touch.move(point(1, 100, 170));
        touch.move(point(2, 200, 170));
        touch.move(point(1, 100, 150));
        touch.move(point(2, 200, 150));
        touch.up(point(1, 100, 150));
        touch.up(point(2, 200, 150));
        // Fingers going up show what is below: the page scrolls down.
        const scrolled = said.filter((entry) => `scroll` in entry).map((entry) => (`scroll` in entry ? entry.scroll[1] : 0));
        expect(scrolled.reduce((sum, dy) => sum + dy, 0)).toBe(50);
        expect(pointers(said)).toEqual([]);
    });

    // A magnified view moves first; only what it cannot absorb at its edge scrolls the page.
    test("a zoomed view pans before the page scrolls", () => {
        const { said, touch, point } = surface((dx, dy) => [dx, dy / 2]);
        touch.down(point(1, 100, 200));
        touch.down(point(2, 200, 200));
        touch.move(point(1, 100, 160));
        touch.move(point(2, 200, 160));
        const scrolled = said.filter((entry) => `scroll` in entry).map((entry) => (`scroll` in entry ? entry.scroll[1] : 0));
        expect(scrolled.reduce((sum, dy) => sum + dy, 0)).toBe(20);
    });

    test("spreading apart pinches the view, centred between the fingers", () => {
        const { said, touch, point } = surface();
        touch.down(point(1, 100, 100));
        touch.down(point(2, 140, 100));
        touch.move(point(1, 60, 100));
        touch.move(point(2, 180, 100));
        const zooms = said.filter((entry) => `zoom` in entry);
        expect(zooms[0]).toMatchObject({ zoom: `begin` });
        expect(zooms.at(-1)).toEqual({ zoom: `pinch`, at: { x: 120, y: 100 }, spread: 60 });
        expect(pointers(said)).toEqual([]);
    });
});

describe("trackpad mode", () => {
    test("a finger moves the cursor from where it is, and a tap clicks there", () => {
        const { said, cursors, touch, point } = surface();
        touch.setTrackpad(true);
        expect(cursors).toEqual([{ x: 200, y: 150 }]);
        touch.down(point(1, 10, 10));
        touch.move(point(1, 10 + TAP_SLOP + 10, 10));
        touch.up(point(1, 30, 10));
        const moved = cursors.at(-1) ?? { x: 0, y: 0 };
        expect(moved.y).toBe(150);
        expect(moved.x).toBeGreaterThan(220);
        touch.down(point(2, 300, 250));
        touch.up(point(2, 300, 250));
        expect(pointers(said).slice(-2)).toEqual([
            { pointer: `down`, at: moved, button: 0, buttons: 1, clickCount: 1 },
            { pointer: `up`, at: moved, button: 0, buttons: 0, clickCount: 1 },
        ]);
    });

    test("a two-finger tap right-clicks where the cursor is", () => {
        const { said, touch, point, wait } = surface();
        touch.setTrackpad(true);
        touch.down(point(1, 10, 10));
        touch.down(point(2, 50, 10));
        wait(100);
        touch.up(point(1, 10, 10));
        touch.up(point(2, 50, 10));
        expect(pointers(said)).toEqual([
            { pointer: `move`, at: { x: 200, y: 150 }, button: 2, buttons: 0, clickCount: 0 },
            { pointer: `down`, at: { x: 200, y: 150 }, button: 2, buttons: 2, clickCount: 1 },
            { pointer: `up`, at: { x: 200, y: 150 }, button: 2, buttons: 0, clickCount: 1 },
        ]);
    });

    test("press and hold, then move, drags from the cursor", () => {
        const { said, touch, point, wait } = surface();
        touch.setTrackpad(true);
        touch.down(point(1, 10, 10));
        wait(LONG_PRESS_MS);
        touch.move(point(1, 40, 10));
        touch.up(point(1, 40, 10));
        const presses = pointers(said);
        expect(presses[0]).toEqual({ pointer: `down`, at: { x: 200, y: 150 }, button: 0, buttons: 1, clickCount: 1 });
        expect(presses.at(-2)).toMatchObject({ pointer: `move`, buttons: 1 });
        expect(presses.at(-1)).toMatchObject({ pointer: `up`, button: 0, buttons: 0 });
    });

    test("the cursor stays inside the picture however far the finger goes", () => {
        const { cursors, touch, point, wait } = surface();
        touch.setTrackpad(true);
        touch.down(point(1, 10, 10));
        wait(1);
        touch.move(point(1, 5000, 5000));
        expect(cursors.at(-1)).toEqual({ x: 399, y: 299 });
    });
});
