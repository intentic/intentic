import { freshImport } from "@intentic/testing/bun";

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
const load = (): Promise<typeof import("./desktop")> => {
    (globalThis as { window?: FakeWindow }).window = {};
    return freshImport<typeof import("./desktop")>("./desktop", import.meta.url);
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

/* A project setup names where the app's own folder lands in the sandbox; a folder the page made up never rides beside it. */
test("the setup link carries a project in place of a sync folder, and a blank one not at all", async () => {
    const { desktopSetupLink } = await load();
    const project = new URL(desktopSetupLink({ code: `abc`, sandboxId: `sbx_7`, name: `My App`, project: `My-App`, syncDir: `~/intentic/my-app-7` }));
    expect([...project.searchParams]).toEqual([
        [`code`, `abc`],
        [`sandbox`, `sbx_7`],
        [`name`, `My App`],
        [`project`, `My-App`],
    ]);
    const blank = new URL(desktopSetupLink({ code: `abc`, project: ``, syncDir: `~/intentic/work-7` }));
    expect([...blank.searchParams]).toEqual([
        [`code`, `abc`],
        [`syncDir`, `~/intentic/work-7`],
    ]);
});

/* The app's progress announcement, read back off a detail that crossed a process boundary: the fields the strip draws survive. */
test("a setup report is read back with its figures and without anything unexpected", async () => {
    const { readDesktopSetupReport } = await load();
    expect(
        readDesktopSetupReport({
            name: `work`,
            state: `running`,
            percent: 42,
            position: `Step 4 of 10`,
            remaining: `about 3 min left`,
            step: `pulling-image`,
            extra: 1,
        }),
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
    expect(new URL(desktopAuthLink(`row`, `nonce`, `desk`)).searchParams.get(`profile`)).toBe(`desk`);
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
    own.close = jest.fn();
    own.focus = jest.fn();
    own.resizeTo = jest.fn();
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

// Every address the page is sent to, in order: what the app's navigation handler would see.
const recordedLocation = () => {
    const sent: string[] = [];
    (globalThis as { location?: unknown }).location = {
        get href(): string {
            return sent.at(-1) ?? ``;
        },
        set href(link: string) {
            sent.push(link);
        },
    };
    (globalThis as { document?: unknown }).document = { readyState: `complete` };
    return { sent };
};

test("a window of the app is closed, raised and widened by the app, one link each", async () => {
    const { closeOwnWindow, raiseOwnWindow, widenOwnWindow } = await load();
    const { sent } = recordedLocation();
    const own = fakeWindow();
    own.__INTENTIC_DESKTOP__ = { version: `1.0.0`, installId: `id`, update: null, frameless: true };
    own.close = jest.fn();
    own.focus = jest.fn();
    own.resizeTo = jest.fn();
    jest.useFakeTimers();
    try {
        closeOwnWindow();
        raiseOwnWindow();
        widenOwnWindow(1279.6);
        jest.advanceTimersByTime(1_000);
    } finally {
        jest.useRealTimers();
    }

    expect(sent).toEqual([`intentic://window?do=close`, `intentic://window?do=raise`, `intentic://window?do=fit&width=1280`]);
    // Nothing is asked of a window that would ignore it.
    expect(own.close).not.toHaveBeenCalled();
    expect(own.focus).not.toHaveBeenCalled();
    expect(own.resizeTo).not.toHaveBeenCalled();
});

/* WEBKIT KEEPS ONLY THE LAST ADDRESS SET IN ONE TASK: links sent together leave one per task, a beat apart, in order. */
test("links sent together reach the app one at a time, the first at once", async () => {
    const { openDesktopLink } = await load();
    const { sent } = recordedLocation();
    jest.useFakeTimers();
    try {
        openDesktopLink(`intentic://window?do=ready`);
        openDesktopLink(`intentic://window?do=mode&mode=dark`);
        openDesktopLink(`intentic://window?do=dirty&value=1`);
        expect(sent).toEqual([`intentic://window?do=ready`]);
        jest.advanceTimersByTime(49);
        expect(sent).toEqual([`intentic://window?do=ready`]);
        jest.advanceTimersByTime(1);
        expect(sent).toEqual([`intentic://window?do=ready`, `intentic://window?do=mode&mode=dark`]);
        jest.advanceTimersByTime(1_000);
        expect(sent).toEqual([`intentic://window?do=ready`, `intentic://window?do=mode&mode=dark`, `intentic://window?do=dirty&value=1`]);
        // Once the queue is empty, the next link leaves at once again.
        openDesktopLink(`intentic://window?do=raise`);
        expect(sent.at(-1)).toBe(`intentic://window?do=raise`);
    } finally {
        jest.useRealTimers();
    }
});
