import "@intentic/testing/dom";
import { effectScope } from "vue";
import { stubGlobal, unstubAllGlobals, advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { raiseOwnWindow, widenOwnWindow } from "../../app/environments/desktop";
import type { FloatingNote } from "./floating";
import * as desktopOriginal from "../../app/environments/desktop";

// Pins the note protocol windows exchange to arbitrate a floating panel, not any one window's bookkeeping:
//
// 1. `here`: a window claims the panel; every other window collapses its place for it.
// 2. `gone`: that window handed the panel back on purpose; it lands here at once, and visibly.
// 3. `unloading`: that window may be reloading, so its place is held for a moment. Otherwise a claim ends when its Web Lock
//    drops, or, where there are no Web Locks, when its beat goes silent.
// 4. Two `here` claims for the same panel: the older one wins.

// What the floating window does to ITSELF goes through one seam (browser: the DOM; desktop app: a link, desktop.test.ts);
// here only that it is asked, and when.
jest.mock(`../../app/environments/desktop`, () => ({
    ...desktopOriginal,
    closeOwnWindow: jest.fn(),
    raiseOwnWindow: jest.fn(),
    widenOwnWindow: jest.fn(),
}));

// What this window says to the others; the channel never delivers a window's own notes back to it.
const posted: FloatingNote[] = [];

class FakeChannel {
    constructor(private readonly name: string) {}
    postMessage(note: FloatingNote): void {
        if (this.name === `intentic.floating`) {
            posted.push(note);
        }
    }
    addEventListener(): void {
        // Notes arrive through receiveFloatingNote instead, not this listener.
    }
}

stubGlobal(`BroadcastChannel`, FakeChannel);

const { claimFloating, createFloatingSurface, floatingOwner, floatingWindowPanel, handBackOwnPanel, receiveFloatingNote } = await import(`./floating`);

const size = () => ({ width: 800, height: 600 });

// The note a floating window beats out; `since` (claim start) is what settles a race between two of them.
const here = (panel: `chat` | `terminal` | `preview`, id: string, since = 1_000) => ({ kind: `here` as const, panel, id, since });

// What a floating window's pagehide says, for a reload and a close alike.
const unloading = (panel: `chat` | `terminal` | `preview`, id: string) => ({ kind: `unloading` as const, panel, id });

// A surface's dock reactions, held in a scope the way PoppablePanels holds them.
const watchDocks = (surface: ReturnType<typeof createFloatingSurface>) => {
    const docked = jest.fn();
    const scope = effectScope();
    scope.run(() => surface.onDocked(docked));
    return { docked, stop: () => scope.stop() };
};

// Web Locks as another window's realm holds them: a request for a held name waits until that window lets go (or the
// asker gives up), which is how the browser tells every other window that one has gone. jsdom has none, so a test that
// skips this runs the lockless path, where a claim beats and its silence is what ends it.
let dropAll: (() => void) | undefined;

const stubLocks = (held: readonly string[]) => {
    const waiting = new Map<string, (() => void)[]>(held.map((name) => [name, []]));
    // The module under test only ever waits on a lock (its grant returns nothing) or holds one (its grant is pending).
    type Granted = () => void | Promise<void>;
    const request = async (name: string, ...rest: [Granted] | [LockOptions, Granted]): Promise<void> => {
        const [granted, signal] = rest.length === 1 ? [rest[0], undefined] : [rest[1], rest[0].signal];
        const queue = waiting.get(name);
        if (queue === undefined) {
            return granted();
        }
        return new Promise<void>((resolve, reject) => {
            queue.push(() => void Promise.resolve(granted()).then(resolve));
            signal?.addEventListener(`abort`, () => reject(new DOMException(`aborted`, `AbortError`)));
        });
    };
    Object.defineProperty(navigator, `locks`, { value: { request }, configurable: true });
    const drop = (name: string): void => {
        const queue = waiting.get(name) ?? [];
        waiting.delete(name);
        for (const grant of queue) {
            grant();
        }
    };
    dropAll = () => [...waiting.keys()].forEach(drop);
    return { drop };
};

beforeEach(() => {
    jest.useFakeTimers();
    jest.setSystemTime(1_000_000);
    localStorage.clear();
    posted.length = 0;
});

afterEach(async () => {
    // Ends every test with the arrangement empty, like a fresh window. Locks go first, then the clock runs out fully,
    // so the module's one timer has retired every claim before the next test's.
    dropAll?.();
    await advanceTimersByTimeAsync(10_000);
    jest.useRealTimers();
    unstubAllGlobals();
    jest.restoreAllMocks();
    jest.clearAllMocks();
    Reflect.deleteProperty(navigator, `locks`);
    dropAll = undefined;
});

describe(`a panel nobody floats`, () => {
    it(`is drawn by this window and offers to open one`, () => {
        const surface = createFloatingSurface(`preview`, size);
        const open = jest.fn((_url: string, _target: string, _features: string) => ({ focus: jest.fn() }) as unknown as Window);
        stubGlobal(`open`, open);

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

        // Silence: what a close, a crash or a kill all look like from here.
        jest.advanceTimersByTime(4_000);

        expect(surface.floats.value).toBe(false);
        expect(surface.shows.value).toBe(true);
    });

    // A reload out there says `unloading`, spends a page load booting, then claims again as a new realm.
    it(`rides out a reload out there without handing the panel back`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const owner = floatingOwner(`chat`);
        const { docked, stop } = watchDocks(surface);
        receiveFloatingNote(here(`chat`, `w-1`));
        jest.advanceTimersByTime(700);
        receiveFloatingNote(unloading(`chat`, `w-1`));

        jest.advanceTimersByTime(2_000);
        expect(surface.shows.value).toBe(false);

        // Younger than the claim it replaces, but live: it holds the panel from its first beat.
        receiveFloatingNote(here(`chat`, `w-2`, 5_000));
        expect(owner.value).toBe(`w-2`);

        for (let beat = 0; beat < 5; beat++) {
            jest.advanceTimersByTime(750);
            receiveFloatingNote(here(`chat`, `w-2`, 5_000));
        }

        expect(surface.shows.value).toBe(false);
        expect(owner.value).toBe(`w-2`);
        expect(docked).not.toHaveBeenCalled();
        stop();
    });

    it(`takes the panel back quietly, once its hold has passed, when that window never comes back`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const { docked, stop } = watchDocks(surface);
        receiveFloatingNote(here(`chat`, `w-1`));
        jest.advanceTimersByTime(740);
        receiveFloatingNote(unloading(`chat`, `w-1`));

        // Past the deadline w-1's last beat would have set; the hold, taken at the unload, still runs.
        jest.advanceTimersByTime(2_900);
        expect(surface.shows.value).toBe(false);

        jest.advanceTimersByTime(200);

        expect(surface.shows.value).toBe(true);
        // A close is not a dock: the panel is back, and nothing moves the reader to it.
        expect(docked).not.toHaveBeenCalled();
        stop();
    });

    it(`reports a hand-back as a dock, and only one that brings the panel back here`, () => {
        const chat = createFloatingSurface(`chat`, size);
        const { docked, stop } = watchDocks(chat);
        receiveFloatingNote(here(`chat`, `winner`, 1_000));
        receiveFloatingNote(here(`chat`, `loser`, 2_000));
        receiveFloatingNote(here(`terminal`, `t-1`));

        // A race loser standing down, and another panel docking, bring the chat nowhere.
        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `loser` });
        receiveFloatingNote({ kind: `gone`, panel: `terminal`, id: `t-1` });
        expect(docked).not.toHaveBeenCalled();

        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `winner` });

        expect(chat.shows.value).toBe(true);
        expect(docked).toHaveBeenCalledTimes(1);
        stop();
    });

    it(`asks a live window to dock and lands the panel when that window hands it back`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const { docked, stop } = watchDocks(surface);
        receiveFloatingNote(here(`chat`, `w-1`));

        surface.dock();

        expect(posted).toEqual([{ kind: `dock`, panel: `chat` }]);
        expect(surface.shows.value).toBe(false);

        receiveFloatingNote({ kind: `gone`, panel: `chat`, id: `w-1` });

        expect(surface.shows.value).toBe(true);
        expect(docked).toHaveBeenCalledTimes(1);
        stop();
    });

    // An unloading window hears nothing, so every window answers a dock request for it rather than wait out its deadline.
    it(`answers a dock for an unloading window itself, whichever window asked`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const { docked, stop } = watchDocks(surface);
        receiveFloatingNote(here(`chat`, `w-1`));
        receiveFloatingNote(unloading(`chat`, `w-1`));

        surface.dock();

        expect(surface.shows.value).toBe(true);
        expect(docked).toHaveBeenCalledTimes(1);

        receiveFloatingNote(here(`chat`, `w-2`));
        receiveFloatingNote(unloading(`chat`, `w-2`));
        receiveFloatingNote({ kind: `dock`, panel: `chat` });

        expect(surface.shows.value).toBe(true);
        expect(docked).toHaveBeenCalledTimes(2);
        stop();
    });

    // A minimized window is not a closed one: the browser throttles a hidden page's timers, so its beat can go as
    // silent as a killed window's. The lock token is what tells them apart.
    it(`leaves the panel out there while that window is only minimized`, async () => {
        const surface = createFloatingSurface(`chat`, size);
        const locks = stubLocks([`intentic.floating.chat.w-1`]);
        receiveFloatingNote(here(`chat`, `w-1`));

        // Many deadlines' worth of silence with no beat; the realm (lock) is still held, though.
        await advanceTimersByTimeAsync(60_000);

        expect(surface.floats.value).toBe(true);
        expect(surface.shows.value).toBe(false);

        // When that window really goes, the browser drops the lock with it, and this window, queued on it, hears so.
        locks.drop(`intentic.floating.chat.w-1`);
        await advanceTimersByTimeAsync(600);

        expect(surface.shows.value).toBe(true);
    });

    // The browser can drop a reloading window's lock a moment before its `unloading` arrives; that moment must not read
    // as a close, or the panel flashes back here between the two realms.
    it(`hears a reload whose lock dropped before it said it was unloading`, async () => {
        const surface = createFloatingSurface(`chat`, size);
        const locks = stubLocks([`intentic.floating.chat.w-1`]);
        receiveFloatingNote(here(`chat`, `w-1`));

        locks.drop(`intentic.floating.chat.w-1`);
        await advanceTimersByTimeAsync(100);
        receiveFloatingNote(unloading(`chat`, `w-1`));
        await advanceTimersByTimeAsync(2_000);
        expect(surface.shows.value).toBe(false);

        receiveFloatingNote(here(`chat`, `w-2`, 5_000));
        await advanceTimersByTimeAsync(5_000);
        expect([surface.shows.value, floatingOwner(`chat`).value]).toEqual([false, `w-2`]);
    });

    it(`raises that window instead of opening a second one`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const open = jest.fn((_url: string, _target: string, _features: string) => null);
        stubGlobal(`open`, open);
        receiveFloatingNote(here(`chat`, `w-1`));

        surface.open();

        expect(open).not.toHaveBeenCalled();
        // Asked of that window, not done to this one.
        expect(raiseOwnWindow).not.toHaveBeenCalled();
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
        jest.setSystemTime(since);
        const scope = effectScope();
        scope.run(() => claimFloating(panel, onDock));
        return () => scope.stop();
    };

    it(`draws the panel, and says so to every other window`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const release = claim(`chat`, jest.fn());

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

        const release = claim(`chat`, jest.fn());
        await advanceTimersByTimeAsync(1);

        // Named after the claim, with id, so two racing windows get a token at once; the oldest-claim rule decides.
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatch(/^intentic\.floating\.chat\..+/u);
        expect(letGo).toBe(false);

        release();
        await advanceTimersByTimeAsync(1);

        expect(letGo).toBe(true);
    });

    // The lock is what every other window watches, so a window holding one has nothing to repeat; one without keeps
    // saying it is there, since its silence is the only close anyone else can see.
    it(`says it is there once where it holds a lock, and keeps saying so where it cannot`, async () => {
        stubLocks([]);
        const locked = claim(`chat`, jest.fn());
        await advanceTimersByTimeAsync(5_000);
        const withLock = posted.filter((note) => note.kind === `here`).length;
        locked();

        Reflect.deleteProperty(navigator, `locks`);
        posted.length = 0;
        const lockless = claim(`terminal`, jest.fn());
        await advanceTimersByTimeAsync(1_600);
        expect([withLock, posted.filter((note) => note.kind === `here`).length]).toEqual([1, 3]);
        lockless();
    });

    // The window's close would unload it, which says nothing final; the hand-back has to be heard before that.
    const closeAfterHandBack = () =>
        jest.fn(() => {
            expect(posted.filter((note) => note.kind === `gone`)).toHaveLength(1);
            expect(floatingWindowPanel.value).toBeUndefined();
        });

    it(`hands the panel back, then closes, when any window asks it to dock`, () => {
        const close = closeAfterHandBack();
        const release = claim(`chat`, close);

        receiveFloatingNote({ kind: `dock`, panel: `chat` });

        expect(close).toHaveBeenCalledTimes(1);
        release();
        expect(posted.filter((note) => note.kind === `gone`)).toHaveLength(1);
    });

    // Its Dock press, F9 and the desktop app's × are the same hand-back as a dock request from elsewhere.
    it(`hands the panel back, then closes, on its own Dock press and its own ×`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const close = closeAfterHandBack();
        const release = claim(`chat`, close);

        surface.dock();

        expect(close).toHaveBeenCalledTimes(1);
        expect(surface.here.value).toBe(false);
        release();

        posted.length = 0;
        const again = claim(`chat`, closeAfterHandBack());
        expect(handBackOwnPanel()).toBe(true);
        again();
        // A window floating nothing has no panel to hand back; its × is the window's own.
        expect(handBackOwnPanel()).toBe(false);
    });

    // A reload, a close and a trip into bfcache all fire pagehide, and only the last comes back as this same realm.
    it(`holds its claim through pagehide, saying only that it is unloading`, () => {
        const release = claim(`chat`, jest.fn());
        const [announced] = posted;
        if (announced?.kind !== `here`) {
            throw new Error(`a claim announces itself before anything else`);
        }

        window.dispatchEvent(new Event(`pagehide`));

        expect(posted.filter((note) => note.kind !== `here`)).toEqual([{ kind: `unloading`, panel: `chat`, id: announced.id }]);
        expect(floatingWindowPanel.value).toBe(`chat`);
        release();
    });

    it(`raises itself when asked, from its own press or another window`, () => {
        const surface = createFloatingSurface(`chat`, size);
        const release = claim(`chat`, jest.fn());

        surface.open();
        receiveFloatingNote({ kind: `raise`, panel: `chat` });

        expect(raiseOwnWindow).toHaveBeenCalledTimes(2);
        release();
    });

    it(`widens its own window for a pane that would not fit, no further than the screen's edge`, () => {
        const surface = createFloatingSurface(`chat`, size);
        Object.defineProperty(window, `outerWidth`, { value: 900, configurable: true });
        Object.defineProperty(window, `screenX`, { value: 100, configurable: true });
        Object.defineProperty(window.screen, `availWidth`, { value: 2560, configurable: true });
        const release = claim(`chat`, jest.fn());

        surface.fit(1400);
        expect(widenOwnWindow).toHaveBeenLastCalledWith(1400);

        surface.fit(3000);
        expect(widenOwnWindow).toHaveBeenLastCalledWith(2460);

        // Already that wide: nothing to ask.
        surface.fit(800);
        expect(widenOwnWindow).toHaveBeenCalledTimes(2);

        release();
    });

    it(`leaves another panel's dock request alone`, () => {
        const onDock = jest.fn();
        const release = claim(`chat`, onDock);

        receiveFloatingNote({ kind: `dock`, panel: `terminal` });

        expect(onDock).not.toHaveBeenCalled();
        release();
    });

    // Both windows independently reach the same verdict about the same pair; the younger claim is always the one
    // that stands down.
    it(`stands down for an older claim on the same panel`, () => {
        const onDock = jest.fn();
        const release = claim(`chat`, onDock, 5_000);

        receiveFloatingNote(here(`chat`, `older`, 4_000));

        expect(onDock).toHaveBeenCalledTimes(1);
        release();
    });

    it(`keeps the panel when the other claim is younger`, () => {
        const onDock = jest.fn();
        const release = claim(`chat`, onDock, 4_000);

        receiveFloatingNote(here(`chat`, `younger`, 5_000));

        expect(onDock).not.toHaveBeenCalled();
        release();
    });

    it(`breaks a tie on the same millisecond by id, so exactly one of the pair goes`, () => {
        const onDock = jest.fn();
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
        const open = jest.fn((_url: string, _target: string, _features: string) => ({ focus: jest.fn() }) as unknown as Window);
        stubGlobal(`open`, open);
        // The floating window's own record of where it was, written from its own realm, not measured while closing.
        localStorage.setItem(`intentic.floating.frame.terminal`, `2200,180,900,1100`);

        surface.open();

        expect(open.mock.calls[0]?.[2]).toBe(`popup=1,width=900,height=1100,left=2200,top=180`);
    });

    it(`ignores a frame stranded on a screen that is no longer attached`, () => {
        const surface = createFloatingSurface(`terminal`, size);
        const open = jest.fn((_url: string, _target: string, _features: string) => ({ focus: jest.fn() }) as unknown as Window);
        stubGlobal(`open`, open);
        // One screen, with a frame far off its right edge: unreachable, so the panel opens centred instead.
        Object.defineProperty(window.screen, `isExtended`, { value: false, configurable: true });
        Object.defineProperty(window.screen, `availWidth`, { value: 1440, configurable: true });
        localStorage.setItem(`intentic.floating.frame.terminal`, `4000,100,900,700`);

        surface.open();

        expect(open.mock.calls[0]?.[2]).toContain(`width=800`);
    });

    it(`refuses a frame no window was ever deliberately left at`, () => {
        const surface = createFloatingSurface(`terminal`, size);
        const open = jest.fn((_url: string, _target: string, _features: string) => ({ focus: jest.fn() }) as unknown as Window);
        stubGlobal(`open`, open);
        localStorage.setItem(`intentic.floating.frame.terminal`, `0,0,12,8`);

        surface.open();

        expect(open.mock.calls[0]?.[2]).toContain(`width=800`);
    });
});
