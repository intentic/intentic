// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { onScreen } from "./onScreen";

/* "Is anyone looking at THIS window", and that is the whole question now. It used to be a question about
 * several: a floating panel was drawn by the app's tab, so the tab's own visibility said nothing about the
 * window the reader was in, and reading it alone reported them away in the very window they were reading in.
 * A floating panel runs its own copy of the app (composables/floating.ts), so each window answers for itself,
 * and the app's presence is the union its windows report to the daemon. */

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
