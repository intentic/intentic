import "@intentic/testing/dom";
import { stubGlobal } from "@intentic/testing/bun";

// The desktop app's webview drops a `target="_blank"` press without telling the app anything (WebView2 raises its
// new-window event for `window.open` and a named target, and for `_blank` raises nothing). These pin the substitution
// that makes those links leave the app again, and pin that nothing else on the page is touched.

interface Desktop {
    version: string;
    installId: string;
    update: string | null;
}

const asApp = (desktop: Desktop | undefined): void => {
    (window as Window & { __INTENTIC_DESKTOP__?: Desktop }).__INTENTIC_DESKTOP__ = desktop;
};

// Installed once for the whole file, as it is in a window: the listener it adds has no removal and outlives any test.
asApp({ version: `1.275.0`, installId: `i-1`, update: null });
const { installDesktopLinks } = await import("./desktop");
installDesktopLinks();

const opened: string[] = [];

const linkOnPage = (attributes: Record<string, string>): HTMLAnchorElement => {
    const link = document.createElement(`a`);
    for (const [name, value] of Object.entries(attributes)) {
        link.setAttribute(name, value);
    }
    link.textContent = `link`;
    document.body.append(link);
    return link;
};

/* A link on the page, pressed the way a reader presses it. Returns whether the press was answered here. */
const press = (attributes: Record<string, string>, modifiers: MouseEventInit = {}): boolean => {
    const link = linkOnPage(attributes);
    const event = new window.MouseEvent(`click`, { bubbles: true, cancelable: true, button: 0, ...modifiers });
    link.dispatchEvent(event);
    link.remove();
    return event.defaultPrevented;
};

const contextMenu = (target: EventTarget): boolean => {
    const event = new window.MouseEvent(`contextmenu`, { bubbles: true, cancelable: true, button: 2 });
    target.dispatchEvent(event);
    return event.defaultPrevented;
};

// Stubbed rather than spied on: the DOM shim carries `open` as an accessor, and a spy cannot stand in for one.
stubGlobal(`open`, (url: string | URL | undefined) => {
    opened.push(String(url));
    return null;
});

afterEach(() => {
    opened.length = 0;
    window.getSelection()?.removeAllRanges();
    document.body.replaceChildren();
});

test("a link out of the app is re-issued as the one shape the app hears", () => {
    expect(press({ href: `https://claude.ai/oauth/authorize?state=abc`, target: `_blank`, rel: `noopener` })).toBe(true);
    expect(opened).toEqual([`https://claude.ai/oauth/authorize?state=abc`]);
});

// A press anywhere inside the link is the same press: the anchor is found from whatever glyph or icon was under it.
test("a press on what the link contains counts as a press on the link", () => {
    const link = document.createElement(`a`);
    link.href = `https://intentic.dev/docs/`;
    link.target = `_blank`;
    const icon = document.createElement(`span`);
    link.append(icon);
    document.body.append(link);
    icon.dispatchEvent(new window.MouseEvent(`click`, { bubbles: true, cancelable: true, button: 0 }));
    expect(opened).toEqual([`https://intentic.dev/docs/`]);
});

// The app decides where a re-issued address goes (windows.rs): its own origin is not special here, since a page of the
// app opened in a new tab is not something this webview can do either.
test("the app's own origin is re-issued too, not followed in place", () => {
    expect(press({ href: `/sandbox/agent`, target: `_blank` })).toBe(true);
    expect(opened).toEqual([`${window.location.origin}/sandbox/agent`]);
});

// Ctrl/Shift-click is "open this elsewhere", and the app's opener plugin injects its own window-level listener that
// takes the press (`preventDefault`) and then hands it to an IPC command no window of this app is allowed to call —
// so the press died with `Command plugin:opener|open_url not allowed by ACL` and nothing on screen. Answered here
// first, in capture, for the same reason `_blank` is: this page decides where its links go.
test("ctrl-click and shift-click leave for the browser rather than dying in the webview", () => {
    expect(press({ href: `https://intentic.dev/docs/` }, { ctrlKey: true })).toBe(true);
    expect(press({ href: `/agents` }, { shiftKey: true })).toBe(true);
    expect(press({ href: `https://intentic.dev/docs/`, target: `_blank` }, { ctrlKey: true })).toBe(true);
    expect(opened).toEqual([`https://intentic.dev/docs/`, `${window.location.origin}/agents`, `https://intentic.dev/docs/`]);
});

// Cmd-click on a Mac is the same gesture; the plugin's listener ignores it (it bails on `metaKey`), so the webview's
// own handling stands and this page must not take the press away from it.
test("cmd-click is left to the webview, which is what the plugin does with it too", () => {
    expect(press({ href: `https://intentic.dev/docs/` }, { metaKey: true })).toBe(false);
    expect(opened).toEqual([]);
});

test("every other link on the page is left exactly as it was", () => {
    /* This window's own navigation: the router's, and the one target the webview follows itself. */
    expect(press({ href: `/sandbox/agent` })).toBe(false);
    expect(press({ href: `/sandbox/agent`, target: `_self` })).toBe(false);
    /* A file the browser saves in place rather than a page it shows elsewhere. */
    expect(press({ href: `/api/export.zip`, target: `_blank`, download: `export.zip` })).toBe(false);
    /* A named target is the one the webview already hands the app. */
    expect(press({ href: `https://intentic.dev/`, target: `preview` })).toBe(false);
    expect(opened).toEqual([]);
});

test.each([`/workspace`, `#/device`, `${window.location.origin}/files/local#/workspace`, `intentic://launcher`, `intentic://local?do=open-folder`])(
    "internal desktop link %s has no browser link menu",
    (href) => {
        expect(contextMenu(linkOnPage({ href }))).toBe(true);
        expect(opened).toEqual([]);
    },
);

test("right-clicking a nested SVG icon finds its internal navigation link", () => {
    const link = linkOnPage({ href: `#/workspace` });
    const icon = document.createElementNS(`http://www.w3.org/2000/svg`, `svg`);
    const path = document.createElementNS(`http://www.w3.org/2000/svg`, `path`);
    icon.append(path);
    link.append(icon);
    expect(contextMenu(path)).toBe(true);
});

test.each([
    `https://intentic.dev/docs/`,
    `mailto:help@example.com`,
    `tel:+12025550100`,
    `blob:${window.location.origin}/document`,
    `data:text/plain,notes`,
])("useful link %s keeps its native menu", (href) => {
    expect(contextMenu(linkOnPage({ href }))).toBe(false);
});

test("downloads keep Save link as even on the app's own origin", () => {
    expect(contextMenu(linkOnPage({ href: `/api/export.zip`, download: `export.zip` }))).toBe(false);
});

test.each([`input`, `textarea`, `select`, `span`])("editing in an internal link's %s keeps its native menu", (tag) => {
    const link = linkOnPage({ href: `#/workspace` });
    const editor = document.createElement(tag);
    if (tag === `span`) {
        editor.setAttribute(`contenteditable`, `true`);
        // jsdom does not implement the browser's inherited editing flag.
        Object.defineProperty(editor, `isContentEditable`, { value: true });
    }
    link.append(editor);
    expect(contextMenu(editor)).toBe(false);
});

test("selected link text keeps its native Copy action", () => {
    const link = linkOnPage({ href: `#/workspace` });
    window.getSelection()?.selectAllChildren(link);
    expect(contextMenu(link)).toBe(false);
});

test("a selection elsewhere does not bring the broken menu back on a navigation icon", () => {
    const text = document.createElement(`p`);
    text.textContent = `Selected document text`;
    document.body.append(text);
    window.getSelection()?.selectAllChildren(text);
    expect(contextMenu(linkOnPage({ href: `#/workspace` }))).toBe(true);
});

test("custom menus get first refusal and native-menu suppression never stops propagation", () => {
    const custom = linkOnPage({ href: `/workspace` });
    const seenBeforeCustomMenu: boolean[] = [];
    custom.addEventListener(`contextmenu`, (event) => {
        seenBeforeCustomMenu.push(event.defaultPrevented);
        event.preventDefault();
    });
    const bubbled = jest.fn();
    window.addEventListener(`contextmenu`, bubbled);
    try {
        expect(contextMenu(custom)).toBe(true);
        expect(seenBeforeCustomMenu).toEqual([false]);
        expect(contextMenu(linkOnPage({ href: `#/device` }))).toBe(true);
        expect(bubbled).toHaveBeenCalledTimes(2);
    } finally {
        window.removeEventListener(`contextmenu`, bubbled);
    }
});

test("ordinary text, controls, empty anchors and non-element targets keep their menus", () => {
    const text = document.createElement(`p`);
    text.textContent = `Document text`;
    const control = document.createElement(`button`);
    document.body.append(text, control);
    expect(contextMenu(text)).toBe(false);
    expect(contextMenu(control)).toBe(false);
    expect(contextMenu(linkOnPage({}))).toBe(false);
    expect(contextMenu(document)).toBe(false);
});

test("in a browser nothing is installed at all: `_blank` needs no help there", () => {
    asApp(undefined);
    const watching = jest.spyOn(document, `addEventListener`);
    try {
        installDesktopLinks();
        expect(watching).not.toHaveBeenCalled();
    } finally {
        watching.mockRestore();
        asApp({ version: `1.275.0`, installId: `i-1`, update: null });
    }
});
