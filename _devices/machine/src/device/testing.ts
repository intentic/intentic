import type { Desktop, MouseButton, NoticeEvents, Point, ScrollDirection, WindowInfo } from "@intentic/desktop-automation";
import type { IndicatorDeps } from "./indicator.js";

// The fake desktop the tool tests drive (this repo's `testing.ts` convention, excluded from the build), so both
// tool suites share one double. @intentic/desktop-automation's methods move a real cursor on a real screen and
// can only be exercised by hand; this records instead of acting.

export interface FakeDesktop {
    readonly desktop: Desktop;
    // Every call, in order, as readable strings, asserted against directly so a test reads as a transcript.
    readonly calls: string[];
    // What the fake reports as open. Mutable so a test can stage a machine with two windows and a focus change.
    windows: WindowInfo[];
    clipboard: string;
}

export const fakeWindow = (overrides: Partial<WindowInfo> = {}): WindowInfo => ({
    id: "1",
    title: "Untitled",
    app: "app",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    focused: false,
    ...overrides,
});

export const fakeDesktop = (): FakeDesktop => {
    const calls: string[] = [];
    const state: { windows: WindowInfo[]; clipboard: string } = { windows: [], clipboard: "" };
    const desktop: Desktop = {
        frame: async () => ({ width: 1920, height: 1080, origin: { x: 0, y: 0 } }),
        capture: async () => Buffer.alloc(0),
        move: async (to: Point) => void calls.push(`move ${to.x},${to.y}`),
        click: async (at: Point, button: MouseButton) => void calls.push(`click ${button} ${at.x},${at.y}`),
        doubleClick: async (at: Point) => void calls.push(`double ${at.x},${at.y}`),
        drag: async (from: Point, to: Point) => void calls.push(`drag ${from.x},${from.y}->${to.x},${to.y}`),
        type: async (text: string) => void calls.push(`type ${text}`),
        key: async (combo: string) => void calls.push(`key ${combo}`),
        scroll: async (at: Point, direction: ScrollDirection, amount: number) => void calls.push(`scroll ${direction} ${amount} @${at.x},${at.y}`),
        windows: async () => state.windows,
        focusWindow: async (id: string) => {
            calls.push(`focus ${id}`);
            // Focus actually moves, so a test can assert on what the tool reports back rather than only that it asked.
            state.windows = state.windows.map((window) => ({ ...window, focused: window.id === id }));
        },
        launch: async (target: string) => void calls.push(`launch ${target}`),
        readClipboard: async () => state.clipboard,
        writeClipboard: async (text: string) => {
            calls.push(`clipboard ${text}`);
            state.clipboard = text;
        },
    };
    return {
        desktop,
        calls,
        get windows() {
            return state.windows;
        },
        set windows(next: WindowInfo[]) {
            state.windows = next;
        },
        get clipboard() {
            return state.clipboard;
        },
        set clipboard(next: string) {
            state.clipboard = next;
        },
    };
};

// One helper the indicator opened: every text it was shown, whether it was closed, and the events to play back
// through it, which stand in for the person at the keyboard and for a helper that dies.
export interface FakeHelper {
    readonly shown: string[];
    closed: boolean;
    readonly events: NoticeEvents;
}

// The indicator's seams over fakes: helpers that record instead of drawing (none at all with `notices: false`, as
// off Windows), the pause as a value rather than a file, and the audit log as a list.
export interface FakeIndicatorDeps {
    readonly deps: IndicatorDeps;
    readonly helpers: FakeHelper[];
    readonly audited: { tool: string; ok: boolean; detail: string }[];
    // The pause as saved: what the next agent to start would read back.
    readonly saved: () => boolean;
}

export const fakeIndicatorDeps = ({
    paused = false,
    notices = true,
}: { readonly paused?: boolean; readonly notices?: boolean } = {}): FakeIndicatorDeps => {
    const helpers: FakeHelper[] = [];
    const audited: FakeIndicatorDeps["audited"] = [];
    let saved = paused;
    return {
        deps: {
            open: (events) => {
                if (!notices) {
                    return undefined;
                }
                const helper: FakeHelper = { shown: [], closed: false, events };
                helpers.push(helper);
                return {
                    // The real helper drops a line sent after close; one sent here is a bug in the caller, said loudly.
                    show: (text) => {
                        if (helper.closed) {
                            throw new Error(`"${text}" was shown on a notice already closed`);
                        }
                        helper.shown.push(text);
                    },
                    close: () => {
                        helper.closed = true;
                    },
                };
            },
            paused: async () => saved,
            setPaused: async (next) => {
                saved = next;
            },
            audit: async (entry) => void audited.push(entry),
        },
        helpers,
        audited,
        saved: () => saved,
    };
};
