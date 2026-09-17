// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
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
    current = { paths: [`README.md`], onDrop: vi.fn<(dir: string) => void>() };
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

    it(`counts several, and refuses a secondary button or nothing to carry`, () => {
        current = { paths: [`a`, `b`, `c`], onDrop: vi.fn<(dir: string) => void>() };
        press();
        move(30, 30);
        expect(label.value).toBe(`3 items`);
        release();
        press(10, 10, 2);
        move(30, 30);
        expect(dragging.value, `a right-press is a menu`).toBe(false);
        current = { paths: [], onDrop: vi.fn<(dir: string) => void>() };
        press();
        move(30, 30);
        expect(dragging.value).toBe(false);
    });
});
