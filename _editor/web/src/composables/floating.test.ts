// @vitest-environment jsdom
import { effectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimFloating, createFloatingSurface, floatingWindowPanel, receiveFloatingNote } from "./floating";

/* THE ONE SHARED FACT: a floating window announces itself, and every window reads its whole view of the
 * arrangement off that. What is pinned here is the arrangement rather than any window's bookkeeping, because
 * bookkeeping was the old shape's whole problem: a panel painted from another window's realm needed a liveness
 * protocol to tell a live panel from a photograph of one, and none of it could catch two perfectly healthy
 * windows disagreeing.
 *
 * So each test speaks in notes on the channel, which is the only thing windows exchange:
 *   · `here`, somebody is floating this panel. Every other window collapses its place for it.
 *   · silence past the deadline, that window is gone, whatever took it (a dock, a close, a crash, a kill).
 *   · `here` from a SECOND window, exactly one of the two survives, and it is the older claim.
 */

const size = () => ({ width: 800, height: 600 });

// The note a floating window beats out. `since` is when its claim began, which is the whole of how a race
// between two of them is settled.
const here = (panel: `chat` | `terminal` | `preview`, id: string, since = 1_000) => ({ kind: `here` as const, panel, id, since });

/* THE OTHER SIGNAL: the token a floating window holds for as long as its realm exists, which is what tells a
 * window the browser has stopped running on time from a window that is gone. jsdom has no Web Locks, so every
 * test that does not install this runs the beat-only path a browser without them takes. */
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
    /* EVERY TEST ENDS WITH THE ARRANGEMENT EMPTY, which is also the state a fresh window starts in. The module
     * is a singleton and its sweep is one interval: dropping the fake clock while that interval is live leaves a
     * dead id standing in for a running timer, `startSweeping` sees a sweep it thinks is already going, and the
     * next test that needs one silently never gets it. So the tokens go first and the clock is run out until
     * every claim has been retired and the sweep has stood itself down. */
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

        // A route of the app, resolved against its base, not a page of its own: the window boots a copy of the
        // app and renders the panel itself.
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
        // The whole reason a docked window collapses: there is one chat surface and it is out there.
        expect(surface.shows.value).toBe(false);

        // Silence, which is what a dock, a close, a crash and a killed window all look like from here.
        vi.advanceTimersByTime(4_000);

        expect(surface.floats.value).toBe(false);
        expect(surface.shows.value).toBe(true);
    });

    it(`rides out a reload out there without flashing the panel back`, () => {
        const surface = createFloatingSurface(`chat`, size);
        receiveFloatingNote(here(`chat`, `w-1`));

        // A page load out there is a gap in the beat, and the deadline is deliberately several beats long.
        vi.advanceTimersByTime(1_000);
        expect(surface.shows.value).toBe(false);

        receiveFloatingNote(here(`chat`, `w-1`));
        vi.advanceTimersByTime(1_000);

        expect(surface.shows.value).toBe(false);
    });

    /* A MINIMIZED WINDOW IS NOT A CLOSED ONE, and no deadline can tell them apart: a minimized window is a
     * hidden page, and the browser throttles a hidden page's timers to about one a minute once it has been
     * hidden five minutes (and may stop them altogether), so the window the user PUT AWAY falls as silent as the
     * one they killed. Without the token, the panel was reclaimed out from under a chat still sitting on the
     * second screen: the rail grew its Chat tile back and a second live copy of the conversation mounted here. */
    it(`leaves the panel out there while that window is only minimized`, async () => {
        const surface = createFloatingSurface(`chat`, size);
        const locks = stubLocks([`intentic.floating.chat.w-1`]);
        receiveFloatingNote(here(`chat`, `w-1`));

        // Twenty-four deadlines' worth of silence, without one beat in it. Its realm is still there.
        await vi.advanceTimersByTimeAsync(60_000);

        expect(surface.floats.value).toBe(true);
        expect(surface.shows.value).toBe(false);

        // And when that window really goes, the browser drops the token with it: no beat, no realm, no claim.
        locks.drop();
        await vi.advanceTimersByTimeAsync(2_000);

        expect(surface.shows.value).toBe(true);
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
        // A LOSER's farewell, which lands right after the winner's claim. Retiring on it would collapse the
        // panel back into this window for a beat and then take it away again.
        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `loser` });

        expect(surface.shows.value).toBe(false);
    });
});

describe(`the floating window itself`, () => {
    // The window's own half: claim the panel, beat, and act on what it hears. Held in a scope, because the
    // claim is released with the route component that took it.
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
        // What the shell reads to keep the panel mounted at any width: a floating window is desktop by intent.
        expect(floatingWindowPanel.value).toBe(`chat`);

        release();

        expect(surface.here.value).toBe(false);
        expect(floatingWindowPanel.value).toBeUndefined();
    });

    /* The claimant's half of the reading above: hold a token nobody has to remember to renew, and let it go
     * only when this window stops being the panel's window while staying open (a lost session bounced to
     * /login). A window that is closed, crashed or killed never gets here and the browser does it instead. */
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

        // Named after the CLAIM, id and all, so two windows racing for one panel are granted both tokens at
        // once and neither queues behind the other: the oldest-claim rule settles that, never this lock.
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

    /* DUPLICATES CANNOT SURVIVE. Both windows hear each other, both reach the same verdict about the same pair,
     * and the younger claim is the one that goes. This is what replaced relying on window.open's target name,
     * which only ever deduplicated inside one browsing context group and therefore not between two app tabs. */
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
        // This window's id is a uuid, so `aaa…` sorts below it and wins; the pair's other half reaches the
        // mirror-image verdict about this one and stays.
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
        // The floating window's own reading of where the user left it, written from its own realm rather than
        // measured across windows while it was closing.
        localStorage.setItem(`intentic.floating.frame.terminal`, `2200,180,900,1100`);

        surface.open();

        expect(open.mock.calls[0]?.[2]).toBe(`popup=1,width=900,height=1100,left=2200,top=180`);
    });

    it(`ignores a frame stranded on a screen that is no longer attached`, () => {
        const surface = createFloatingSurface(`terminal`, size);
        const open = vi.fn((_url: string, _target: string, _features: string) => ({ focus: vi.fn() }) as unknown as Window);
        vi.stubGlobal(`open`, open);
        // One screen, and a frame far off the right of it: a window opened out there is one the user can
        // neither find nor close, so the panel opens centred instead.
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
