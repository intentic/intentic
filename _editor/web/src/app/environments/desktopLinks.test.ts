// @vitest-environment jsdom
import { afterEach, expect, test, vi } from "vitest";

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

/* A link on the page, pressed the way a reader presses it. Returns whether the press was answered here. */
const press = (attributes: Record<string, string>): boolean => {
    const link = document.createElement(`a`);
    for (const [name, value] of Object.entries(attributes)) {
        link.setAttribute(name, value);
    }
    link.textContent = `link`;
    document.body.append(link);
    const event = new window.MouseEvent(`click`, { bubbles: true, cancelable: true, button: 0 });
    link.dispatchEvent(event);
    link.remove();
    return event.defaultPrevented;
};

vi.spyOn(window, `open`).mockImplementation((url) => {
    opened.push(String(url));
    return null;
});

afterEach(() => {
    opened.length = 0;
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

test("in a browser nothing is installed at all: `_blank` needs no help there", () => {
    asApp(undefined);
    const watching = vi.spyOn(document, `addEventListener`);
    try {
        installDesktopLinks();
        expect(watching).not.toHaveBeenCalled();
    } finally {
        watching.mockRestore();
        asApp({ version: `1.275.0`, installId: `i-1`, update: null });
    }
});
