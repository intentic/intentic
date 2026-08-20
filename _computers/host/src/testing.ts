import type { Desktop, MouseButton, Point, ScrollDirection, WindowInfo } from "@intentic/desktop";

/* The fake desktop the tool tests drive, the repo's `testing.ts` convention (excluded from the build, like the
 * sandbox's own), so both tool suites share ONE double rather than each keeping a copy that drifts.
 *
 * It exists because @intentic/desktop's methods end in a real cursor moving on a real screen: they can only be
 * exercised by a human watching. Everything worth asserting about the layer above, was the action refused, was
 * the coordinate checked, did the right method get called with the right arguments, needs a Desktop that
 * records instead of acts. That is the entire argument for keeping the mechanics in their own package. */

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
            // Focus actually moves, so a test can assert on what the tool reports back rather than only that it
            // asked, which is the half that would otherwise never be covered.
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
