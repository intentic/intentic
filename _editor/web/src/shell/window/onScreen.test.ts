import "@intentic/testing/dom";
import { describe, it, expect, afterEach } from "bun:test";
import { onScreen } from "./onScreen";

/* "Is anyone looking at THIS window", and that is the whole question now. */

// jsdom answers `visible` for the page's own document and cannot be set, so it is dressed by hand, the way the
// browser would report it.
const show = (visible: boolean): void => {
    Object.defineProperty(document, `visibilityState`, { value: visible ? `visible` : `hidden`, configurable: true });
    document.dispatchEvent(new Event(`visibilitychange`));
};

afterEach(() => show(true));

describe(`onScreen`, () => {
    it(`follows this window's visibility`, () => {
        expect(onScreen.value).toBe(true);

        show(false);

        expect(onScreen.value).toBe(false);

        show(true);

        expect(onScreen.value).toBe(true);
    });
});
