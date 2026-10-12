import "@intentic/testing/dom";
import { freshImport } from "@intentic/testing/bun";

// Whether This computer's window is on screen, for its 30-second reading of the machine: the app's own word, since a
// Windows webview hidden in the tray still calls its document visible, and the document's word beside it.

const load = () => freshImport<typeof import("./onScreen")>("./onScreen", import.meta.url);

const say = (detail: unknown): void => {
    window.dispatchEvent(new CustomEvent(`intentic-desktop-shown`, { detail }));
};

let visibility: DocumentVisibilityState = `visible`;
Object.defineProperty(document, `visibilityState`, { configurable: true, get: () => visibility });

afterEach(() => {
    visibility = `visible`;
    say({ shown: true });
});

it(`is off screen while the app says the window is hidden, whatever the document says`, async () => {
    const { followOnScreen, onScreen } = await load();
    followOnScreen();
    const before = onScreen.value;
    say({ shown: false });
    const hidden = onScreen.value;
    say({ shown: true });
    expect([before, hidden, onScreen.value]).toEqual([true, false, true]);
});

it(`is off screen while the document is hidden, and takes nothing from a detail of another shape`, async () => {
    const { followOnScreen, onScreen } = await load();
    followOnScreen();
    visibility = `hidden`;
    document.dispatchEvent(new Event(`visibilitychange`));
    const documentHidden = onScreen.value;
    visibility = `visible`;
    document.dispatchEvent(new Event(`visibilitychange`));
    say({ shown: `no` });
    say(null);
    expect([documentHidden, onScreen.value]).toEqual([false, true]);
});
