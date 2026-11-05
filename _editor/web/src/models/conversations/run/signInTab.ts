import { withTimeout } from "@intentic/base/async";
import { writeClipboard } from "@intentic/ui/clipboard";
import { t } from "@intentic/ui/i18n";
import { desktopApp } from "../../../app/environments/desktop";

// ONE PRESS TO THE PROVIDER'S PAGE. "Add account" used to start the sign-in and then wait for a second press, "Open
// claude.ai", because the page's address exists only once the sandbox has minted the attempt, and a browser lets a page
// open a tab only inside the press itself, never a second later when the answer comes back. Readers pressed the first
// button and then had to find the second (owner, 2026-11-05). So the press holds a tab, blank but for a line saying what
// it waits for, and the attempt's address is sent there the moment the sandbox answers; the panel opens on its second
// step, the field the code comes back to.
//
// A device sign-in's code goes with the reader, as it did with the old Open press: written to the clipboard through the
// held tab, which is the focused document by then (a write from this one is refused as unfocused). A browser that
// refuses even that (Firefox and Safari want a press of their own) gets the code drawn in the held tab with one button
// that copies it there and goes on, so the reader never has to come back here to read it.
//
// The desktop app has no popup blocker in the way: every `window.open` leaves for the system browser (hosted.rs
// `on_new_window`), so it opens the page when the address arrives, with nothing held. Without a press behind the start
// (a link that arrived by address) nothing is held at all, and the panel offers the page's own Open button as before.

// How long the held tab waits on the clipboard before drawing the code instead. A write normally lands at once or is
// refused at once; one left pending (a permission prompt elsewhere holding the clipboard) must not leave the reader on a
// blank tab.
const COPY_WAIT_MS = 1_500;

export interface SignInTab {
    // Sends the reader on to the sign-in page, a device code on the clipboard first where the attempt has one. Answers
    // whether the reader got there (a held tab closed meanwhile did not) and whether the code went with them.
    readonly send: (url: string, code: string) => Promise<{ readonly sent: boolean; readonly copied: boolean }>;
    // Gives the tab back when nothing was sent to it: the sign-in never started, or another took its place.
    readonly release: () => void;
}

// Plain DOM in a tab that is not this app's: no stylesheet reaches it, so its few rules are set through the style object
// (which a content policy allows, where a style attribute in markup would not be).
const paint = (tab: Window, title: string, build: (doc: Document) => HTMLElement[]): void => {
    try {
        const doc = tab.document;
        doc.title = title;
        doc.documentElement.style.colorScheme = `light dark`;
        Object.assign(doc.body.style, {
            margin: `0`,
            minHeight: `100vh`,
            display: `flex`,
            flexDirection: `column`,
            alignItems: `center`,
            justifyContent: `center`,
            gap: `20px`,
            padding: `24px`,
            boxSizing: `border-box`,
            font: `15px/1.5 system-ui, sans-serif`,
            textAlign: `center`,
        });
        doc.body.replaceChildren(...build(doc));
        // allow(silent-catch): a tab gone cross-origin or closed has nothing left to draw on; sending it still works.
    } catch {
        return;
    }
};

const line = (doc: Document, text: string, style: Partial<CSSStyleDeclaration> = {}): HTMLElement => {
    const element = doc.createElement(`p`);
    element.textContent = text;
    Object.assign(element.style, { margin: `0`, ...style });
    return element;
};

const holdBrowserTab = (destination: string): SignInTab | undefined => {
    const held = window.open(``, `_blank`);
    if (held === null) {
        return undefined;
    }
    const waiting = t(`sandbox.connectFlow.tabOpening`, { destination });
    paint(held, waiting, (doc) => [line(doc, waiting, { opacity: `0.7` })]);
    let claimed = false;
    // Severed from this page before it leaves, as the panel's own links are (`noopener`).
    const go = (url: string): void => {
        held.opener = null;
        held.location.replace(url);
    };
    // The code the page will ask for, read here, with the one press that copies it and goes on.
    const showCode = (url: string, code: string): void =>
        paint(held, code, (doc) => {
            const button = doc.createElement(`button`);
            button.type = `button`;
            button.textContent = t(`sandbox.connectFlow.tabCopyContinue`, { destination });
            Object.assign(button.style, { font: `inherit`, padding: `8px 16px`, borderRadius: `8px`, cursor: `pointer` });
            button.addEventListener(`click`, () => void writeClipboard(code, button).then(() => go(url)));
            return [
                line(doc, t(`sandbox.connectFlow.tabEnterCode`), { opacity: `0.7` }),
                line(doc, code, { font: `600 32px ui-monospace, monospace`, letterSpacing: `0.2em`, userSelect: `all` }),
                button,
            ];
        });
    return {
        send: async (url, code) => {
            claimed = true;
            if (held.closed) {
                return { sent: false, copied: false };
            }
            if (code === ``) {
                go(url);
                return { sent: true, copied: false };
            }
            // allow(silent-catch): the only rejection is the deadline (writeClipboard never rejects); a copy that did not land is drawn below
            const copied = await withTimeout(writeClipboard(code, held.document.body), COPY_WAIT_MS).catch(() => false);
            if (copied) {
                go(url);
            } else {
                showCode(url, code);
            }
            return { sent: !held.closed, copied };
        },
        release: () => {
            if (!claimed && !held.closed) {
                held.close();
            }
        },
    };
};

const desktopHandOff: SignInTab = {
    send: async (url, code) => {
        // Copied before the browser takes the screen, while this window is still the focused one.
        const copied = code !== `` && (await writeClipboard(code));
        window.open(url);
        return { sent: true, copied };
    },
    release: () => undefined,
};

// Called inside the press that starts a sign-in, before anything is awaited: the only moment a tab may be opened.
// `destination` is the site the tab is waiting for, said in it meanwhile.
export const holdSignInTab = (destination: string): SignInTab | undefined => {
    // Nobody pressed anything (a start that came with the address): opening a page unasked would be a surprise.
    if (navigator.userActivation?.isActive === false) {
        return undefined;
    }
    return desktopApp() === undefined ? holdBrowserTab(destination) : desktopHandOff;
};
