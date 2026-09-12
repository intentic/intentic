// @vitest-environment jsdom
import { effectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimFloating, createFloatingSurface, floatingWindowPanel, receiveFloatingNote } from "./floating";

// Pins the note protocol windows exchange to arbitrate a floating panel, not any one window's bookkeeping:
//
// 1. `here`: a window claims the panel; every other window collapses its place for it.
// 2. Silence past the deadline: that window is gone, however it went.
// 3. Two `here` claims for the same panel: the older one wins.

const size = () => ({ width: 800, height: 600 });

// The note a floating window beats out; `since` (claim start) is what settles a race between two of them.
const here = (panel: `chat` | `terminal` | `preview`, id: string, since = 1_000) => ({ kind: `here` as const, panel, id, since });

// Web Lock stub: jsdom has no Web Locks, so a test that skips this runs the beat-only path instead.
let lockedNames: Set<string> | undefined;

const stubLocks = (held: readonly string[]) => {
    const names = new Set(held);
    lockedNames = names;
    Object.defineProperty(navigator, `locks`, {
        value: { query: () => Promise.resolve({ held: [...names].map((name) => ({ name })), pending: [] }) },
        configurable: true,
    });
    return { drop: (): void => names.clear() };
};

beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    localStorage.clear();
});

afterEach(async () => {
    // Ends every test with the arrangement empty, like a fresh window. Tokens go first, then the clock runs out fully,
    // so the module's one sweep interval fully retires and doesn't wedge the next test's.
    lockedNames?.clear();
    await vi.advanceTimersByTimeAsync(10_000);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    Reflect.deleteProperty(navigator, `locks`);
    lockedNames = undefined;
});

describe(`a panel nobody floats`, () => {
    it(`is drawn by this window and offers to open one`, () => {
        const surface = createFloatingSurface(`preview`, size);
        const open = vi.fn((_url: string, _target: string, _features: string) => ({ focus: vi.fn() }) as unknown as Window);
        vi.stubGlobal(`open`, open);

        expect(surface.floats.value).toBe(false);
        expect(surface.here.value).toBe(false);
        expect(surface.shows.value).toBe(true);

        surface.open();

        // A route of the app, not a standalone page: the window boots a copy of the app and renders the panel there.
        expect(open.mock.calls[0]?.[0]).toBe(`/floating/preview`);
        expect(open.mock.calls[0]?.[2]).toContain(`popup=1`);
    });
});

describe(`a panel floating in another window`, () => {
    it(`collapses this window's place for it, and hands it back when the beat stops`, () => {
        const surface = createFloatingSurface(`chat`, size);

        receiveFloatingNote(here(`chat`, `w-1`));

        expect(surface.floats.value).toBe(true);
        expect(surface.here.value).toBe(false);
        expect(surface.shows.value).toBe(false);

        // Silence: what a dock, a close, a crash or a kill all look like from here.
        vi.advanceTimersByTime(4_000);

        expect(surface.floats.value).toBe(false);
        expect(surface.shows.value).toBe(true);
    });

    it(`rides out a reload out there without flashing the panel back`, () => {
        const surface = createFloatingSurface(`chat`, size);
        receiveFloatingNote(here(`chat`, `w-1`));

        // A page load out there is a gap in the beat; the deadline is deliberately several beats long.
        vi.advanceTimersByTime(1_000);
        expect(surface.shows.value).toBe(false);

        receiveFloatingNote(here(`chat`, `w-1`));
        vi.advanceTimersByTime(1_000);

        expect(surface.shows.value).toBe(false);
    });

    // A minimized window is not a closed one: the browser throttles a hidden page's timers, so its beat can go as
    // silent as a killed window's. The lock token is what tells them apart.
    it(`leaves the panel out there while that window is only minimized`, async () => {
        const surface = createFloatingSurface(`chat`, size);
        const locks = stubLocks([`intentic.floating.chat.w-1`]);
        receiveFloatingNote(here(`chat`, `w-1`));

        // Many deadlines' worth of silence with no beat; the realm (lock) is still held, though.
        await vi.advanceTimersByTimeAsync(60_000);

        expect(surface.floats.value).toBe(true);
        expect(surface.shows.value).toBe(false);

        // When that window really goes, the browser drops the token with it: no beat, no realm, no claim.
        locks.drop();
        await vi.advanceTimersByTimeAsync(2_000);

        expect(surface.shows.value).toBe(true);
    });

    it(`waits for a fresh liveness query before expiring a claim after suspension`, async () => {
        const surface = createFloatingSurface(`chat`, size);
        stubLocks([`intentic.floating.chat.w-1`]);
        receiveFloatingNote(here(`chat`, `w-1`));

        vi.advanceTimersByTime(4_000);
        await Promise.resolve();

        expect(surface.shows.value).toBe(false);
    });

    it(`raises that window instead of opening a second one`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const open = vi.fn((_url: string, _target: string, _features: string) => null);
        vi.stubGlobal(`open`, open);
        receiveFloatingNote(here(`chat`, `w-1`));

        surface.open();

        expect(open).not.toHaveBeenCalled();
    });

    it(`ignores a farewell from a window that is not the one it is watching`, () => {
        const surface = createFloatingSurface(`chat`, size);
        receiveFloatingNote(here(`chat`, `winner`, 1_000));
        // A loser's stale farewell landing right after the winner's claim; retiring on it would flash the panel back.
        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `loser` });

        expect(surface.shows.value).toBe(false);
    });

    it(`keeps the winning window when a competing claim arrives and closes`, () => {
        const surface = createFloatingSurface(`chat`, size);
        receiveFloatingNote(here(`chat`, `winner`, 1_000));
        receiveFloatingNote(here(`chat`, `loser`, 2_000));
        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `loser` });

        expect(surface.shows.value).toBe(false);
        expect(surface.floats.value).toBe(true);
    });
});

describe(`the floating window itself`, () => {
    // The window's own half: claim the panel, beat, and act on what it hears. Held in a scope, since the claim
    // releases with the route component that took it.
    const claim = (panel: `chat` | `terminal`, onDock: () => void, since = 1_000) => {
        vi.setSystemTime(since);
        const scope = effectScope();
        scope.run(() => claimFloating(panel, onDock));
        return () => scope.stop();
    };

    it(`draws the panel, and says so to every other window`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const release = claim(`chat`, vi.fn());

        expect(surface.here.value).toBe(true);
        expect(surface.floats.value).toBe(true);
        expect(surface.shows.value).toBe(true);
        // What the shell reads to keep the panel mounted at any width; a floating window is desktop by intent.
        expect(floatingWindowPanel.value).toBe(`chat`);

        release();

        expect(surface.here.value).toBe(false);
        expect(floatingWindowPanel.value).toBeUndefined();
    });

    // Holds a token nobody has to renew, released only when this window stops being the panel's window while staying
    // open; a closed, crashed or killed window never reaches this and the browser drops it instead.
    it(`takes a token for its claim and gives it back when it stops being that window`, async () => {
        const asked: string[] = [];
        let letGo = false;
        Object.defineProperty(navigator, `locks`, {
            value: {
                request: (name: string, hold: () => Promise<void>) => {
                    asked.push(name);
                    return hold().then(() => {
                        letGo = true;
                    });
                },
                query: () => Promise.resolve({ held: [], pending: [] }),
            },
            configurable: true,
        });

        const release = claim(`chat`, vi.fn());
        await vi.advanceTimersByTimeAsync(1);

        // Named after the claim, with id, so two racing windows get a token at once; the oldest-claim rule decides.
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatch(/^intentic\.floating\.chat\..+/u);
        expect(letGo).toBe(false);

        release();
        await vi.advanceTimersByTimeAsync(1);

        expect(letGo).toBe(true);
    });

    it(`closes itself when any window asks it to dock`, () => {
        const onDock = vi.fn();
        const release = claim(`chat`, onDock);

        receiveFloatingNote({ kind: `dock`, panel: `chat` });

        expect(onDock).toHaveBeenCalledTimes(1);
        release();
    });

    it(`leaves another panel's dock request alone`, () => {
        const onDock = vi.fn();
        const release = claim(`chat`, onDock);

        receiveFloatingNote({ kind: `dock`, panel: `terminal` });

        expect(onDock).not.toHaveBeenCalled();
        release();
    });

    // Both windows independently reach the same verdict about the same pair; the younger claim is always the one
    // that stands down.
    it(`stands down for an older claim on the same panel`, () => {
        const onDock = vi.fn();
        const release = claim(`chat`, onDock, 5_000);

        receiveFloatingNote(here(`chat`, `older`, 4_000));

        expect(onDock).toHaveBeenCalledTimes(1);
        release();
    });

    it(`keeps the panel when the other claim is younger`, () => {
        const onDock = vi.fn();
        const release = claim(`chat`, onDock, 4_000);

        receiveFloatingNote(here(`chat`, `younger`, 5_000));

        expect(onDock).not.toHaveBeenCalled();
        release();
    });

    it(`breaks a tie on the same millisecond by id, so exactly one of the pair goes`, () => {
        const onDock = vi.fn();
        const release = claim(`chat`, onDock, 4_000);
        // A lower id sorts first and wins; the other half of the pair reaches the mirror verdict and stays.
        receiveFloatingNote(here(`chat`, `00000000-0000-0000-0000-000000000000`, 4_000));

        expect(onDock).toHaveBeenCalledTimes(1);
        release();
    });
});

describe(`where the window comes back`, () => {
    it(`reopens on the frame the floating window last reported`, () => {
        const surface = createFloatingSurface(`terminal`, size);
        const open = vi.fn((_url: string, _target: string, _features: string) => ({ focus: vi.fn() }) as unknown as Window);
        vi.stubGlobal(`open`, open);
        // The floating window's own record of where it was, written from its own realm, not measured while closing.
        localStorage.setItem(`intentic.floating.frame.terminal`, `2200,180,900,1100`);

        surface.open();

        expect(open.mock.calls[0]?.[2]).toBe(`popup=1,width=900,height=1100,left=2200,top=180`);
    });

    it(`ignores a frame stranded on a screen that is no longer attached`, () => {
        const surface = createFloatingSurface(`terminal`, size);
        const open = vi.fn((_url: string, _target: string, _features: string) => ({ focus: vi.fn() }) as unknown as Window);
        vi.stubGlobal(`open`, open);
        // One screen, with a frame far off its right edge: unreachable, so the panel opens centred instead.
        Object.defineProperty(window.screen, `isExtended`, { value: false, configurable: true });
        Object.defineProperty(window.screen, `availWidth`, { value: 1440, configurable: true });
        localStorage.setItem(`intentic.floating.frame.terminal`, `4000,100,900,700`);

        surface.open();

        expect(open.mock.calls[0]?.[2]).toContain(`width=800`);
    });

    it(`refuses a frame no window was ever deliberately left at`, () => {
        const surface = createFloatingSurface(`terminal`, size);
        const open = vi.fn((_url: string, _target: string, _features: string) => ({ focus: vi.fn() }) as unknown as Window);
        vi.stubGlobal(`open`, open);
        localStorage.setItem(`intentic.floating.frame.terminal`, `0,0,12,8`);

        surface.open();

        expect(open.mock.calls[0]?.[2]).toContain(`width=800`);
    });
});
