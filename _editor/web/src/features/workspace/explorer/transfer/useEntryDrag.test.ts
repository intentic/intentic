import "@intentic/testing/dom";
import { describe, it, expect, beforeEach, afterEach, mock, jest, type Mock } from "bun:test";
import { beginEntryDrag, consumeSuppressedClick, useEntryDrag } from "./useEntryDrag";

// jsdom lays nothing out: the element the drag is over is whatever the test says it is.
let under: Element | null = null;
const target = (dir: string | undefined): HTMLElement => {
    const el = document.createElement(`div`);
    if (dir !== undefined) {
        el.dataset[`dropDir`] = dir;
    }
    document.body.append(el);
    return el;
};

const press = (x = 10, y = 10, button = 0): void => {
    const el = document.createElement(`button`);
    document.body.append(el);
    const event = new MouseEvent(`pointerdown`, { bubbles: true, button, clientX: x, clientY: y });
    beginEntryDrag(event as PointerEvent, { paths: current.paths, onDrop: current.onDrop });
};
const move = (x: number, y: number): void => {
    window.dispatchEvent(new MouseEvent(`pointermove`, { bubbles: true, cancelable: true, clientX: x, clientY: y }));
};
const release = (): void => {
    window.dispatchEvent(new MouseEvent(`pointerup`, { bubbles: true }));
};

const { dragging, over, label } = useEntryDrag();
let current: { paths: readonly string[]; onDrop: Mock<(dir: string) => void> };

beforeEach(() => {
    document.body.replaceChildren();
    under = null;
    document.elementFromPoint = () => under;
    current = { paths: [`README.md`], onDrop: mock<(dir: string) => void>() };
});

afterEach(() => {
    release();
    consumeSuppressedClick();
});

describe(`a pointer drag of an entry`, () => {
    it(`becomes a drag only past the threshold, and names what it carries`, () => {
        press();
        move(12, 12);
        expect(dragging.value).toBe(false);
        move(30, 30);
        expect(dragging.value).toBe(true);
        expect(label.value).toBe(`README.md`);
    });

    it(`lights the folder under the pointer, and only one that can take the paths`, () => {
        under = target(`src`);
        press();
        move(30, 30);
        expect(over.value).toBe(`src`);
        // Already there: nothing to move into.
        under = target(``);
        move(31, 31);
        expect(over.value).toBeUndefined();
        under = target(undefined);
        move(32, 32);
        expect(over.value, `an element offering no folder`).toBeUndefined();
    });

    it(`runs the move on release over a folder, and only then`, () => {
        under = target(`src`);
        press();
        move(30, 30);
        release();
        expect(current.onDrop).toHaveBeenCalledWith(`src`);
        expect(dragging.value).toBe(false);
    });

    it(`moves nothing on a release over nowhere, or before the drag began`, () => {
        press();
        move(30, 30);
        release();
        expect(current.onDrop).not.toHaveBeenCalled();
        under = target(`src`);
        press();
        release();
        expect(current.onDrop, `a click is not a drop`).not.toHaveBeenCalled();
    });

    it(`is cancelled by Escape`, () => {
        under = target(`src`);
        press();
        move(30, 30);
        window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape` }));
        expect(dragging.value).toBe(false);
        release();
        expect(current.onDrop).not.toHaveBeenCalled();
    });

    it(`swallows the click a drag leaves behind, and no other`, () => {
        press();
        move(30, 30);
        release();
        expect(consumeSuppressedClick()).toBe(true);
        expect(consumeSuppressedClick()).toBe(false);
        press();
        release();
        expect(consumeSuppressedClick(), `a plain click`).toBe(false);
    });

    it(`swallows the release that follows an Escape, since the press was a drag and not a click`, () => {
        press();
        move(30, 30);
        window.dispatchEvent(new KeyboardEvent(`keydown`, { key: `Escape` }));
        release();
        expect(consumeSuppressedClick()).toBe(true);
    });

    // A drag released over nothing draggable leaves a click no row ever fires: over the editor, off the window, or
    // taken by the OS. Nothing consumes the claim, so only the deadline can end it.
    it(`lets an unrelated click through once the drag's own click never came`, () => {
        jest.useFakeTimers();
        try {
            press();
            move(30, 30);
            release();
            jest.advanceTimersByTime(1_000);
            expect(consumeSuppressedClick(), `a click a second later is a new gesture`).toBe(false);
        } finally {
            jest.useRealTimers();
        }
    });

    // Load-bearing for the callers: a row that cannot travel presses with no paths rather than returning early, and
    // relies on the claim being ended ahead of that guard.
    it(`ends the claim on a press that carries nothing`, () => {
        press();
        move(30, 30);
        release();
        current = { paths: [], onDrop: mock<(dir: string) => void>() };
        press();
        release();
        expect(consumeSuppressedClick(), `a locked row's own click`).toBe(false);
    });

    it(`counts several, and refuses a secondary button or nothing to carry`, () => {
        current = { paths: [`a`, `b`, `c`], onDrop: mock<(dir: string) => void>() };
        press();
        move(30, 30);
        expect(label.value).toBe(`3 items`);
        release();
        press(10, 10, 2);
        move(30, 30);
        expect(dragging.value, `a right-press is a menu`).toBe(false);
        current = { paths: [], onDrop: mock<(dir: string) => void>() };
        press();
        move(30, 30);
        expect(dragging.value).toBe(false);
    });
});
