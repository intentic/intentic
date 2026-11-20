import "@intentic/testing/dom";
import { wheelCounter, zoomStepOf, zoomsOwnPage } from "./textZoom";

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent(`keydown`, init);

describe(`zoomStepOf`, () => {
    it(`reads Ctrl with plus, equals, minus and zero as the browser's zoom keys`, () => {
        expect(zoomStepOf(key({ ctrlKey: true, key: `=`, code: `Equal` }), false)).toBe(1);
        expect(zoomStepOf(key({ ctrlKey: true, shiftKey: true, key: `+`, code: `Equal` }), false)).toBe(1);
        expect(zoomStepOf(key({ ctrlKey: true, key: `+`, code: `NumpadAdd` }), false)).toBe(1);
        expect(zoomStepOf(key({ ctrlKey: true, key: `-`, code: `Minus` }), false)).toBe(-1);
        expect(zoomStepOf(key({ ctrlKey: true, key: `-`, code: `NumpadSubtract` }), false)).toBe(-1);
        expect(zoomStepOf(key({ ctrlKey: true, key: `0`, code: `Digit0` }), false)).toBe(0);
    });

    it(`goes by the character a layout types, so a German "+" key zooms and its "ß" key does not`, () => {
        expect(zoomStepOf(key({ ctrlKey: true, key: `+`, code: `BracketRight` }), false)).toBe(1);
        expect(zoomStepOf(key({ ctrlKey: true, key: `-`, code: `Slash` }), false)).toBe(-1);
        expect(zoomStepOf(key({ ctrlKey: true, key: `ß`, code: `Minus` }), false)).toBeUndefined();
    });

    it(`falls back to the key under the finger when it typed no character`, () => {
        expect(zoomStepOf(key({ ctrlKey: true, key: `Dead`, code: `Equal` }), false)).toBe(1);
    });

    it(`leaves every other chord alone: no modifier, Alt or AltGr, the other platform's modifier, Shift+0`, () => {
        expect(zoomStepOf(key({ key: `=`, code: `Equal` }), false)).toBeUndefined();
        expect(zoomStepOf(key({ ctrlKey: true, altKey: true, key: `-`, code: `Minus` }), false)).toBeUndefined();
        expect(zoomStepOf(key({ metaKey: true, key: `=`, code: `Equal` }), false)).toBeUndefined();
        expect(zoomStepOf(key({ ctrlKey: true, shiftKey: true, key: `)`, code: `Digit0` }), false)).toBeUndefined();
        expect(zoomStepOf(key({ ctrlKey: true, key: `p`, code: `KeyP` }), false)).toBeUndefined();
    });

    it(`takes ⌘ on a Mac, where Ctrl+minus stays the system's`, () => {
        expect(zoomStepOf(key({ metaKey: true, key: `=`, code: `Equal` }), true)).toBe(1);
        expect(zoomStepOf(key({ ctrlKey: true, key: `-`, code: `Minus` }), true)).toBeUndefined();
    });
});

// Ctrl+= over a live browser zooms the page it shows, not the editor's text, so the window's capture leaves it alone.
describe(`zoomsOwnPage`, () => {
    test(`a live browser's keyboard keeps the zoom keys, and any other field does not`, () => {
        const sink = document.createElement(`textarea`);
        sink.setAttribute(`data-zooms-own-page`, ``);
        const stage = document.createElement(`div`);
        stage.setAttribute(`data-zooms-own-page`, ``);
        const inside = document.createElement(`span`);
        stage.append(inside);
        expect([zoomsOwnPage(sink), zoomsOwnPage(inside), zoomsOwnPage(document.createElement(`input`)), zoomsOwnPage(null)]).toEqual([
            true,
            true,
            false,
            false,
        ]);
    });
});

describe(`wheelCounter`, () => {
    it(`zooms one rung per mouse notch, out when the wheel turns down`, () => {
        const count = wheelCounter();
        expect(count(100, 0)).toBe(-1);
        expect(count(-100, 400)).toBe(1);
        expect(count(-53, 800)).toBe(1);
    });

    it(`gathers a touchpad's small movements into a rung, and drops what a pause or a turn leaves`, () => {
        const count = wheelCounter();
        expect(count(-20, 0)).toBeUndefined();
        expect(count(-20, 16)).toBeUndefined();
        expect(count(-20, 32)).toBe(1);
        expect(count(-40, 48)).toBeUndefined();
        expect(count(30, 64)).toBeUndefined();
        expect(count(-40, 1000)).toBeUndefined();
    });
});
