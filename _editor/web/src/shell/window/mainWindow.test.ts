// @vitest-environment jsdom
import { effectScope } from "vue";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// A link pressed in a popped-out panel goes to the window with the app in it, never itself; pinned via channel notes,
// since a unit test can't have two real windows exchanging them.

interface Note {
    readonly kind: string;
    readonly id?: string;
    readonly at?: number;
    readonly to?: string;
    readonly errand?: { readonly kind: string; readonly path: string; readonly line?: number };
}

const posted: Note[] = [];

class FakeChannel {
    constructor(private readonly name: string) {}
    postMessage(note: Note): void {
        // Filters to this module's channel; floating.ts's own channel is a separate instance, not captured here.
        if (this.name === `intentic.main-window`) {
            posted.push(note);
        }
    }
    addEventListener(): void {
        // Notes arrive via receiveMainWindowNote directly, not through this listener.
    }
}

vi.stubGlobal(`BroadcastChannel`, FakeChannel);

const { claimFloating, receiveFloatingNote } = await import("./floating");
const { handOffToMainWindow, receiveMainWindowNote, sendLinkToMainWindow, useMainWindow } = await import("./mainWindow");

// A file mention as it rides the wire, including the line and scope a URL alone can't carry.
const FILE = { kind: `file`, path: `src/foo.ts`, line: 42, scope: { agent: `c-1` } } as const;

// Simulates the popped-out chat window, which has nowhere of its own to put a file.
const popOut = (): (() => void) => {
    const scope = effectScope();
    scope.run(() => claimFloating(`chat`, vi.fn()));
    return () => scope.stop();
};

// Simulates a window with the app open, announcing itself; `at` is when its reader was last active there.
const appWindow = (id: string, at = 1_000): void => receiveMainWindowNote({ kind: `here`, id, at });

let open: ReturnType<typeof vi.fn>;

// Advanced far past any prior test's claims and errands each run, so the module's roster starts effectively empty.
let clock = 1_000_000;

beforeEach(() => {
    vi.useFakeTimers();
    clock += 10_000_000;
    vi.setSystemTime(clock);
    posted.length = 0;
    open = vi.fn(() => ({ focus: vi.fn() }) as unknown as Window);
    vi.stubGlobal(`open`, open);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

describe(`a link pressed in a popped-out panel`, () => {
    it(`goes to the window with the app in it, and opens no window of its own`, () => {
        const dock = popOut();
        appWindow(`w-1`);

        expect(handOffToMainWindow(FILE)).toBe(true);

        expect(posted.at(-1)).toEqual({ kind: `errand`, to: `w-1`, errand: FILE });
        expect(open).not.toHaveBeenCalled();
        dock();
    });

    it(`goes to the one the reader was last in`, () => {
        const dock = popOut();
        appWindow(`w-old`, 1_000);
        appWindow(`w-recent`, 9_000);

        handOffToMainWindow(FILE);

        expect(posted.at(-1)?.to).toBe(`w-recent`);
        dock();
    });

    it(`stays exactly where it is: nothing is asked of this window`, () => {
        const dock = popOut();
        appWindow(`w-1`);

        handOffToMainWindow({ kind: `route`, path: `/subagents/t-1` });

        expect(open).not.toHaveBeenCalled();
        expect(posted.at(-1)).toEqual({ kind: `errand`, to: `w-1`, errand: { kind: `route`, path: `/subagents/t-1` } });
        dock();
    });
});

describe(`with the app's window closed`, () => {
    it(`opens one on the workspace and hands the file over the moment it arrives`, () => {
        const dock = popOut();

        expect(handOffToMainWindow(FILE)).toBe(true);

        expect(open).toHaveBeenCalledWith(`/workspace`, `intentic-main`);
        expect(posted.some((note) => note.kind === `errand`)).toBe(false);

        appWindow(`w-new`, 1_000_000);

        expect(posted.at(-1)).toEqual({ kind: `errand`, to: `w-new`, errand: FILE });
        dock();
    });

    it(`boots the new window straight at a route, with nothing left waiting`, () => {
        const dock = popOut();

        handOffToMainWindow({ kind: `route`, path: `/browsers/s-1` });
        appWindow(`w-new`);

        expect(open).toHaveBeenCalledWith(`/browsers/s-1`, `intentic-main`);
        expect(posted.some((note) => note.kind === `errand`)).toBe(false);
        dock();
    });

    it(`writes off a window that stopped saying it was there`, () => {
        const dock = popOut();
        appWindow(`w-1`);

        vi.advanceTimersByTime(4_000);
        handOffToMainWindow(FILE);

        expect(open).toHaveBeenCalledWith(`/workspace`, `intentic-main`);
        dock();
    });

    it(`forgets an errand nothing ever came for`, () => {
        const dock = popOut();

        handOffToMainWindow(FILE);
        vi.advanceTimersByTime(60_000);
        appWindow(`w-much-later`);

        expect(posted.some((note) => note.kind === `errand`)).toBe(false);
        dock();
    });
});

// Pins which links a popped-out panel intercepts and sends to the main window, and which it leaves alone.
describe(`any link pressed in a popped-out panel`, () => {
    const click = (html: string, init: MouseEventInit = {}): { event: MouseEvent; root: HTMLElement } => {
        const root = document.createElement(`div`);
        root.innerHTML = html;
        document.body.append(root);
        root.addEventListener(`click`, sendLinkToMainWindow, true);
        const event = new MouseEvent(`click`, { bubbles: true, cancelable: true, ...init });
        root.querySelector(`a`)?.dispatchEvent(event);
        root.remove();
        return { event, root };
    };

    it(`leaves for the app's own window, and this window does not follow it`, () => {
        const dock = popOut();
        appWindow(`w-1`);

        const { event } = click(`<a href="/capabilities/github">Open setup</a>`);

        expect(posted.at(-1)).toEqual({ kind: `errand`, to: `w-1`, errand: { kind: `route`, path: `/capabilities/github` } });
        expect(event.defaultPrevented).toBe(true);
        dock();
    });

    it(`keeps the query and the fragment the link was written with`, () => {
        const dock = popOut();
        appWindow(`w-1`);

        click(`<a href="/sandbox/agent?connect=gemini#accounts">Connect</a>`);

        expect(posted.at(-1)?.errand?.path).toBe(`/sandbox/agent?connect=gemini#accounts`);
        dock();
    });

    it(`leaves a file mention to the handler that knows its line`, () => {
        const dock = popOut();
        appWindow(`w-1`);

        const { event } = click(`<a class="md-file-link" href="/workspace/src/foo.ts" data-file="src/foo.ts" data-line="42">foo.ts:42</a>`);

        expect(event.defaultPrevented).toBe(false);
        expect(posted.some((note) => note.kind === `errand`)).toBe(false);
        dock();
    });

    it(`leaves the rest of the web alone`, () => {
        const dock = popOut();
        appWindow(`w-1`);

        const { event } = click(`<a href="https://intentic.dev/docs">Docs</a>`);

        expect(event.defaultPrevented).toBe(false);
        expect(posted.some((note) => note.kind === `errand`)).toBe(false);
        dock();
    });

    it(`leaves a click the reader already aimed elsewhere to the browser`, () => {
        const dock = popOut();
        appWindow(`w-1`);

        const { event } = click(`<a href="/agents">Agents</a>`, { metaKey: true });

        expect(event.defaultPrevented).toBe(false);
        expect(posted.some((note) => note.kind === `errand`)).toBe(false);
        dock();
    });
});

describe(`the window with the app in it`, () => {
    const mount = (show: (errand: unknown) => void): (() => void) => {
        const scope = effectScope();
        scope.run(() => useMainWindow(show));
        return () => scope.stop();
    };

    it(`answers a roll-call at once, so a window that has just popped out never has to wait out a beat`, () => {
        const leave = mount(vi.fn());

        receiveMainWindowNote({ kind: `roll` });

        expect(posted.at(-1)?.kind).toBe(`here`);
        leave();
    });

    it(`does the errand addressed to it, and raises itself so the reader sees it`, () => {
        const show = vi.fn();
        const focus = vi.fn();
        vi.stubGlobal(`focus`, focus);
        const leave = mount(show);
        receiveMainWindowNote({ kind: `roll` });
        const id = posted.at(-1)?.id ?? ``;

        receiveMainWindowNote({ kind: `errand`, to: id, errand: FILE });

        expect(show).toHaveBeenCalledWith(FILE);
        expect(focus).toHaveBeenCalledTimes(1);
        leave();
    });

    it(`leaves another window's errand alone`, () => {
        const show = vi.fn();
        const leave = mount(show);

        receiveMainWindowNote({ kind: `errand`, to: `somebody-else`, errand: FILE });

        expect(show).not.toHaveBeenCalled();
        leave();
    });

    it(`says nothing while nothing is floating, and starts the moment something is`, () => {
        const leave = mount(vi.fn());
        expect(posted.some((note) => note.kind === `here`)).toBe(false);

        receiveFloatingNote({ kind: `here`, panel: `chat`, id: `f-1`, since: 1_000 });

        expect(posted.some((note) => note.kind === `here`)).toBe(true);
        leave();
    });

    it(`hands nothing off, because it is where links are supposed to land`, () => {
        expect(handOffToMainWindow(FILE)).toBe(false);
        expect(open).not.toHaveBeenCalled();
    });
});
