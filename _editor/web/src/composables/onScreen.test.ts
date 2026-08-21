// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { onScreen, unwatchOnScreen, watchOnScreen } from "./onScreen";

/* The app renders into more than one window, and only one of them owns the realm. So "is anyone looking?" is a
 * question about ALL of them: a pop-out is the window the user chose to keep on screen, and reading the tab's
 * visibility alone reported them away in the very window they were reading in. */

// jsdom answers `visible` for the page's own document and `prerender` for a detached one (no browsing context),
// and neither can be set, so both windows are dressed by hand, the way the browser would report them.
const show = (doc: Document, visible: boolean): void => {
    Object.defineProperty(doc, `visibilityState`, { value: visible ? `visible` : `hidden`, configurable: true });
    doc.dispatchEvent(new Event(`visibilitychange`));
};

const popoutDocument = (): Document => {
    const doc = document.implementation.createHTMLDocument(`popout`);
    show(doc, true);
    return doc;
};

afterEach(() => show(document, true));

describe(`onScreen`, () => {
    it(`follows the app's own window while it is the only one`, () => {
        expect(onScreen.value).toBe(true);

        show(document, false);

        expect(onScreen.value).toBe(false);
    });

    it(`counts a pop-out window the user is reading while the app's tab is behind another one`, () => {
        const popout = popoutDocument();
        watchOnScreen(popout);
        show(document, false);

        // The reported bug: everything out there is drawn by the hidden tab's realm, so this used to read false
        // and every gate behind it stayed shut until the user clicked back to the tab.
        expect(onScreen.value).toBe(true);

        show(popout, false);

        // Both windows away: a minimized pop-out beside a background tab is nobody looking.
        expect(onScreen.value).toBe(false);
        unwatchOnScreen(popout);
    });

    it(`stops hearing from a window once the panel has left it`, () => {
        const popout = popoutDocument();
        watchOnScreen(popout);
        show(document, false);

        unwatchOnScreen(popout);

        expect(onScreen.value).toBe(false);

        // The document outlives the dock: a window handed back keeps it, so its later visibility must not
        // speak for an app that is no longer rendered in it.
        show(popout, true);

        expect(onScreen.value).toBe(false);
    });
});
