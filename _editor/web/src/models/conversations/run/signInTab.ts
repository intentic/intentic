import { withTimeout } from "@intentic/base/async";
import { writeClipboard } from "@intentic/ui/clipboard";
import { t } from "@intentic/ui/i18n";
import { PROVIDER_BRAND_PATHS, type ProviderBrand, providerFillRule } from "@intentic/constants";
import { lessMotion } from "@intentic/ui/motion";
import { ref } from "vue";
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

// THE TAB'S OWN LOOK. Plain DOM in a tab that is not this app's: no stylesheet reaches it, and a content policy that refuses
// inline <style> refuses it here too, so every rule is set through the style object, and the one motion (the ring turning
// round the provider's mark) through the Web Animations API, which no policy blocks. The colours are the app's own as this
// page draws them now, read off its root, so a reader in Sanctum is not flashed a white page between two dark ones; a
// token that reads blank falls back to the browser's own light or dark.
interface Look {
    readonly canvas: string;
    readonly content: string;
    readonly muted: string;
    readonly line: string;
    readonly primary: string;
    readonly onPrimary: string;
}
const lookOfApp = (): Look => {
    const root = getComputedStyle(document.documentElement);
    const token = (name: string, fallback: string): string => root.getPropertyValue(name).trim() || fallback;
    return {
        canvas: token(`--color-canvas`, `Canvas`),
        content: token(`--color-content`, `CanvasText`),
        muted: token(`--color-muted`, `GrayText`),
        line: token(`--color-line-strong`, `GrayText`),
        primary: token(`--color-primary-500`, `AccentColor`),
        onPrimary: token(`--color-canvas`, `AccentColorText`),
    };
};

const SVG = `http://www.w3.org/2000/svg`;

// The provider's mark, as the app draws it (ProviderLogo.vue): its brand path in the ink's colour, or nothing for a
// provider without one.
const markOf = (doc: Document, brand: ProviderBrand | undefined, look: Look): Element | undefined => {
    if (brand === undefined) {
        return undefined;
    }
    const svg = doc.createElementNS(SVG, `svg`);
    svg.setAttribute(`viewBox`, `0 0 24 24`);
    svg.setAttribute(`width`, `26`);
    svg.setAttribute(`height`, `26`);
    svg.setAttribute(`aria-hidden`, `true`);
    const path = doc.createElementNS(SVG, `path`);
    path.setAttribute(`d`, PROVIDER_BRAND_PATHS[brand]);
    path.setAttribute(`fill`, look.content);
    const rule = providerFillRule(brand);
    if (rule !== undefined) {
        path.setAttribute(`fill-rule`, rule);
    }
    svg.append(path);
    return svg;
};

// The mark on a round plate; while the tab waits, a quarter of its rim turns, as the panel's own starting ring does.
const badge = (doc: Document, brand: ProviderBrand | undefined, look: Look, turning: boolean): HTMLElement => {
    const plate = doc.createElement(`div`);
    Object.assign(plate.style, {
        position: `relative`,
        width: `64px`,
        height: `64px`,
        borderRadius: `50%`,
        display: `flex`,
        alignItems: `center`,
        justifyContent: `center`,
        border: `2px solid ${look.line}`,
        boxSizing: `border-box`,
    });
    const mark = markOf(doc, brand, look);
    if (mark !== undefined) {
        plate.append(mark);
    }
    if (turning) {
        const rim = doc.createElement(`div`);
        Object.assign(rim.style, {
            position: `absolute`,
            inset: `-2px`,
            borderRadius: `50%`,
            border: `2px solid transparent`,
            borderTopColor: look.primary,
        });
        plate.append(rim);
        // A reader who asked for less motion, or a document without the Web Animations API, keeps a still ring, which
        // still says whose page is coming.
        if (`animate` in rim && !lessMotion()) {
            rim.animate([{ transform: `rotate(0turn)` }, { transform: `rotate(1turn)` }], { duration: 900, iterations: Number.POSITIVE_INFINITY });
        }
    }
    return plate;
};

const paint = (tab: Window, title: string, build: (doc: Document, look: Look) => HTMLElement[]): void => {
    try {
        const doc = tab.document;
        const look = lookOfApp();
        doc.title = title;
        doc.documentElement.style.colorScheme = `light dark`;
        Object.assign(doc.body.style, {
            margin: `0`,
            minHeight: `100vh`,
            display: `flex`,
            flexDirection: `column`,
            alignItems: `center`,
            justifyContent: `center`,
            gap: `14px`,
            padding: `24px`,
            boxSizing: `border-box`,
            font: `15px/1.5 system-ui, sans-serif`,
            textAlign: `center`,
            background: look.canvas,
            color: look.content,
        });
        doc.body.replaceChildren(...build(doc, look));
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

// The browser refused the last tab a sign-in's press asked for (a popup blocker), so the panel says that is why nothing
// opened and puts its own Open button forward, rather than leaving the reader looking for a tab that never came.
export const signInTabBlocked = ref(false);

const holdBrowserTab = (destination: string, brand: ProviderBrand | undefined): SignInTab | undefined => {
    const held = window.open(``, `_blank`);
    signInTabBlocked.value = held === null;
    if (held === null) {
        return undefined;
    }
    const waiting = t(`sandbox.connectFlow.tabOpening`, { destination });
    paint(held, waiting, (doc, look) => [
        badge(doc, brand, look, true),
        line(doc, waiting, { fontWeight: `600`, fontSize: `17px`, marginTop: `6px` }),
        line(doc, t(`sandbox.connectFlow.tabSignInThere`, { destination }), { color: look.muted, fontSize: `14px` }),
    ]);
    let claimed = false;
    // Severed from this page before it leaves, as the panel's own links are (`noopener`).
    const go = (url: string): void => {
        held.opener = null;
        held.location.replace(url);
    };
    // The code the page will ask for, read here, with the one press that copies it and goes on.
    const showCode = (url: string, code: string): void =>
        paint(held, code, (doc, look) => {
            const button = doc.createElement(`button`);
            button.type = `button`;
            button.textContent = t(`sandbox.connectFlow.tabCopyContinue`, { destination });
            Object.assign(button.style, {
                font: `inherit`,
                fontWeight: `600`,
                padding: `10px 18px`,
                marginTop: `6px`,
                borderRadius: `10px`,
                border: `0`,
                cursor: `pointer`,
                background: look.primary,
                color: look.onPrimary,
            });
            button.addEventListener(`click`, () => void writeClipboard(code, button).then(() => go(url)));
            return [
                badge(doc, brand, look, false),
                line(doc, t(`sandbox.connectFlow.tabEnterCode`), { color: look.muted, fontSize: `14px`, marginTop: `6px` }),
                line(doc, code, {
                    font: `600 32px ui-monospace, monospace`,
                    letterSpacing: `0.2em`,
                    userSelect: `all`,
                    padding: `10px 18px`,
                    border: `1px solid ${look.line}`,
                    borderRadius: `12px`,
                }),
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
// `destination` is the site the tab is waiting for, said in it meanwhile; `brand` the mark it shows while it waits.
export const holdSignInTab = (destination: string, brand?: ProviderBrand): SignInTab | undefined => {
    signInTabBlocked.value = false;
    // Nobody pressed anything (a start that came with the address): opening a page unasked would be a surprise.
    if (navigator.userActivation?.isActive === false) {
        return undefined;
    }
    return desktopApp() === undefined ? holdBrowserTab(destination, brand) : desktopHandOff;
};
