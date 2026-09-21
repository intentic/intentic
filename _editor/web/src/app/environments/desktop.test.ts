import { expect, test, vi } from "vitest";

/* The page's window, as the module reads it: a browser's until a test marks it as the app's (`__INTENTIC_DESKTOP__`). */
interface FakeWindow {
    __INTENTIC_DESKTOP__?: unknown;
    close?: () => void;
    focus?: () => void;
    resizeTo?: (width: number, height: number) => void;
    outerHeight?: number;
}

const fakeWindow = (): FakeWindow => (globalThis as { window: FakeWindow }).window;

/* The sync handoff's whole payload is two sender-chosen values the Rust side trusts only from the app's own window (setup_link.rs). */
const load = async (): Promise<typeof import("./desktop")> => {
    vi.resetModules();
    (globalThis as { window?: FakeWindow }).window = {};
    return import("./desktop");
};

test("the sync link carries the sandbox url and pairing token, encoded", async () => {
    const { desktopSyncLink } = await load();
    const link = desktopSyncLink({ url: `https://sandbox-abc.example.dev`, pair: `tok+/=123`, name: `My Sandbox` });
    const parsed = new URL(link);
    expect(parsed.protocol).toBe(`intentic:`);
    expect(parsed.host).toBe(`sync`);
    expect(parsed.searchParams.get(`url`)).toBe(`https://sandbox-abc.example.dev`);
    expect(parsed.searchParams.get(`pair`)).toBe(`tok+/=123`);
    expect(parsed.searchParams.get(`name`)).toBe(`My Sandbox`);
});

test("flags ride only when set, and a folder never does", async () => {
    const { desktopSyncLink } = await load();
    const bare = new URL(desktopSyncLink({ url: `https://s.example`, pair: `t` }));
    expect(bare.searchParams.get(`takeover`)).toBeNull();
    expect(bare.searchParams.get(`mirror`)).toBeNull();
    expect(bare.searchParams.get(`name`)).toBeNull();
    expect(bare.searchParams.get(`dir`)).toBeNull();

    const full = new URL(desktopSyncLink({ url: `https://s.example`, pair: `t`, takeover: true, mirror: true }));
    expect(full.searchParams.get(`takeover`)).toBe(`1`);
    expect(full.searchParams.get(`mirror`)).toBe(`1`);
});

/* The app's progress announcement, read back off a detail that crossed a process boundary: the fields the strip draws survive. */
test("a setup report is read back with its figures and without anything unexpected", async () => {
    const { readDesktopSetupReport } = await load();
    expect(
        readDesktopSetupReport({ name: `work`, state: `running`, percent: 42, position: `Step 4 of 10`, remaining: `about 3 min left`, step: `pulling-image`, extra: 1 }),
    ).toEqual({ name: `work`, state: `running`, percent: 42, position: `Step 4 of 10`, remaining: `about 3 min left`, step: `pulling-image` });
    // The optional fields are absent when empty, never empty strings the strip would draw as blanks.
    expect(readDesktopSetupReport({ state: `failed`, percent: 100, name: ``, position: null })).toEqual({ state: `failed`, percent: 100 });
    // A percentage is kept on the bar.
    expect(readDesktopSetupReport({ state: `running`, percent: 140 })?.percent).toBe(100);
});

test("a report in a shape this page has no screen for is nothing", async () => {
    const { readDesktopSetupReport } = await load();
    expect(readDesktopSetupReport(undefined)).toBeUndefined();
    expect(readDesktopSetupReport(`running`)).toBeUndefined();
    expect(readDesktopSetupReport({ state: `exploding`, percent: 10 })).toBeUndefined();
    expect(readDesktopSetupReport({ state: `running`, percent: `10` })).toBeUndefined();
    expect(readDesktopSetupReport({ state: `running`, percent: Number.NaN })).toBeUndefined();
});

/* THE LOOK THE READER ARRIVED IN rides the sign-in handoff, and only when there is one. */
test("the auth handoff carries the profile when the browser has one", async () => {
    const { desktopAuthLink } = await load();
    const bare = new URL(desktopAuthLink(`row+1`, `nonce`));
    expect(bare.host).toBe(`auth`);
    expect(bare.searchParams.get(`handoff`)).toBe(`row+1`);
    expect(bare.searchParams.get(`state`)).toBe(`nonce`);
    expect(bare.searchParams.get(`profile`)).toBeNull();
    expect(new URL(desktopAuthLink(`row`, `nonce`, `maker`)).searchParams.get(`profile`)).toBe(`maker`);
});

test("the scheme is announced only inside the app", async () => {
    const { announceDesktopMode } = await load();
    const location = { href: `` };
    (globalThis as { location?: unknown }).location = location;
    (globalThis as { document?: unknown }).document = { readyState: `complete` };
    // A browser has no app to tell.
    announceDesktopMode(`light`);
    expect(location.href).toBe(``);
    fakeWindow().__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `id`, update: null };
    announceDesktopMode(`light`);
    expect(location.href).toBe(`intentic://window?do=mode&mode=light`);
});

/* A POPUP'S SCRIPT MAY CLOSE, RAISE AND RESIZE ITS OWN WINDOW; a window of the app is never a popup, so there each is a link. */
test("a browser window is closed, raised and widened by the page itself", async () => {
    const { closeOwnWindow, raiseOwnWindow, widenOwnWindow } = await load();
    const location = { href: `` };
    (globalThis as { location?: unknown }).location = location;
    (globalThis as { document?: unknown }).document = { readyState: `complete` };
    const own = fakeWindow();
    own.close = vi.fn();
    own.focus = vi.fn();
    own.resizeTo = vi.fn();
    own.outerHeight = 700;

    closeOwnWindow();
    raiseOwnWindow();
    widenOwnWindow(1279.6);

    expect(own.close).toHaveBeenCalledTimes(1);
    expect(own.focus).toHaveBeenCalledTimes(1);
    // Whole pixels at the height the window already has: only the width was asked for.
    expect(own.resizeTo).toHaveBeenCalledWith(1280, 700);
    expect(location.href).toBe(``);
});

test("a window of the app is closed, raised and widened by the app, one link each", async () => {
    const { closeOwnWindow, raiseOwnWindow, widenOwnWindow } = await load();
    const location = { href: `` };
    (globalThis as { location?: unknown }).location = location;
    (globalThis as { document?: unknown }).document = { readyState: `complete` };
    const own = fakeWindow();
    own.__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `id`, update: null, frameless: true };
    own.close = vi.fn();
    own.focus = vi.fn();
    own.resizeTo = vi.fn();

    closeOwnWindow();
    expect(location.href).toBe(`intentic://window?do=close`);
    raiseOwnWindow();
    expect(location.href).toBe(`intentic://window?do=raise`);
    widenOwnWindow(1279.6);
    expect(location.href).toBe(`intentic://window?do=fit&width=1280`);

    // Nothing is asked of a window that would ignore it.
    expect(own.close).not.toHaveBeenCalled();
    expect(own.focus).not.toHaveBeenCalled();
    expect(own.resizeTo).not.toHaveBeenCalled();
});
