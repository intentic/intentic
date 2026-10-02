import "@intentic/testing/dom";
import { onScreen, receiveDesktopShown } from "./onScreen";

/* "Is anyone looking at THIS window", and that is the whole question now. */

// jsdom answers `visible` for the page's own document and cannot be set, so it is dressed by hand, the way the
// browser would report it.
const show = (visible: boolean): void => {
    Object.defineProperty(document, `visibilityState`, { value: visible ? `visible` : `hidden`, configurable: true });
    document.dispatchEvent(new Event(`visibilitychange`));
};

// The desktop app's word, as shown.rs dispatches it.
const appSays = (detail: unknown): void => {
    window.dispatchEvent(new CustomEvent(`intentic-desktop-shown`, { detail }));
};

afterEach(() => {
    show(true);
    receiveDesktopShown(true);
});

describe(`onScreen`, () => {
    it(`follows this window's visibility`, () => {
        expect(onScreen.value).toBe(true);

        show(false);

        expect(onScreen.value).toBe(false);

        show(true);

        expect(onScreen.value).toBe(true);
    });
});

// WebView2 says `visible` of a window hidden in the tray, so the app says it instead (desktop-app shown.rs).
describe(`onScreen inside the desktop app`, () => {
    it(`is not while the app says the window is hidden, whatever the document says`, () => {
        appSays({ shown: false });

        expect(onScreen.value).toBe(false);

        appSays({ shown: true });

        expect(onScreen.value).toBe(true);
    });

    it(`is not for a hidden document the app calls shown`, () => {
        appSays({ shown: true });
        show(false);

        expect(onScreen.value).toBe(false);
    });

    it(`hears nothing in a detail that says nothing`, () => {
        appSays({ shown: false });
        appSays(null);
        appSays({ shown: `yes` });
        appSays({});

        expect(onScreen.value).toBe(false);
    });
});
