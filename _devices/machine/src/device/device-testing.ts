import {
    type Desktop,
    type DisplayInfo,
    encodePng,
    type MouseButton,
    type NoticeEvents,
    type Point,
    type Rect,
    type ScrollDirection,
    type UiElement,
    type WindowInfo,
} from "@intentic/desktop-automation";
import type { IndicatorDeps } from "./indicator.js";
import type { AdbOutput, AdbRunner } from "./tools/android.js";

// The fake desktop the tool tests drive (this repo's `testing.ts` convention, excluded from the build), so both
// tool suites share one double. @intentic/desktop-automation's methods move a real cursor on a real screen and
// can only be exercised by hand; this records instead of acting.

export interface FakeDesktop {
    readonly desktop: Desktop;
    // Every call, in order, as readable strings, asserted against directly so a test reads as a transcript.
    calls: string[];
    // What the fake reports as open. Mutable so a test can stage a machine with two windows and a focus change.
    windows: WindowInfo[];
    clipboard: string;
    // The grey every captured pixel is: change it and the next screenshot differs from the last.
    shade: number;
    // The controls ui_elements reads, for whichever window is asked.
    elements: UiElement[];
}

export const fakeElement = (overrides: Partial<UiElement> = {}): UiElement => ({
    id: "42.1",
    role: "button",
    name: "OK",
    value: undefined,
    bounds: { x: 100, y: 200, width: 80, height: 30 },
    enabled: true,
    focused: false,
    actions: ["invoke", "focus"],
    depth: 1,
    ...overrides,
});

// A desktop of two monitors side by side, as the frame below adds up to.
export const FAKE_DISPLAYS: readonly DisplayInfo[] = [
    { name: "one", primary: true, bounds: { x: 0, y: 0, width: 1920, height: 1080 } },
    { name: "two", primary: false, bounds: { x: 1920, y: 0, width: 1920, height: 1080 } },
];

const solidPng = (width: number, height: number, shade: number): Buffer =>
    encodePng({ width, height, data: new Uint8Array(width * height * 3).fill(shade) });

export const fakeWindow = (overrides: Partial<WindowInfo> = {}): WindowInfo => ({
    id: "1",
    title: "Untitled",
    app: "app",
    bounds: { x: 0, y: 0, width: 800, height: 600 },
    focused: false,
    ...overrides,
});

// What the fake reads and records, which a test changes in place between calls.
type FakeState = Omit<FakeDesktop, "desktop">;

const screenMethods = (state: FakeState): Pick<Desktop, "frame" | "capture" | "displays"> => ({
    frame: async () => ({ width: 3840, height: 1080, origin: { x: 0, y: 0 } }),
    capture: async (region?: Rect) => {
        state.calls.push(region === undefined ? "capture" : `capture ${region.x},${region.y} ${region.width}x${region.height}`);
        return solidPng(region?.width ?? 3840, region?.height ?? 1080, state.shade);
    },
    displays: async () => [...FAKE_DISPLAYS],
});

const inputMethods = ({ calls }: FakeState): Pick<Desktop, "move" | "click" | "doubleClick" | "drag" | "type" | "key" | "scroll"> => ({
    move: async (to: Point) => void calls.push(`move ${to.x},${to.y}`),
    click: async (at: Point, button: MouseButton) => void calls.push(`click ${button} ${at.x},${at.y}`),
    doubleClick: async (at: Point) => void calls.push(`double ${at.x},${at.y}`),
    drag: async (from: Point, to: Point) => void calls.push(`drag ${from.x},${from.y}->${to.x},${to.y}`),
    type: async (text: string) => void calls.push(`type ${text}`),
    key: async (combo: string) => void calls.push(`key ${combo}`),
    scroll: async (at: Point, direction: ScrollDirection, amount: number) => void calls.push(`scroll ${direction} ${amount} @${at.x},${at.y}`),
});

const appMethods = (state: FakeState): Pick<Desktop, "windows" | "focusWindow" | "launch" | "readClipboard" | "writeClipboard"> => ({
    windows: async () => state.windows,
    focusWindow: async (id: string) => {
        state.calls.push(`focus ${id}`);
        // Focus actually moves, so a test can assert on what the tool reports back rather than only that it asked.
        state.windows = state.windows.map((window) => ({ ...window, focused: window.id === id }));
    },
    launch: async (target: string) => void state.calls.push(`launch ${target}`),
    readClipboard: async () => state.clipboard,
    writeClipboard: async (text: string) => {
        state.calls.push(`clipboard ${text}`);
        state.clipboard = text;
    },
});

const elementMethods = (state: FakeState): Pick<Desktop, "elements" | "element" | "elementAct"> => ({
    elements: async (window?: string) => ({
        window: { id: window ?? "1", title: "Untitled", app: "app" },
        elements: state.elements,
        truncated: false,
    }),
    element: async (_window: string, id: string) => state.elements.find((element) => element.id === id),
    elementAct: async (window, id, action, value) =>
        void state.calls.push(`${action} ${window}/${id}${value === undefined || value === "" ? "" : ` ${value}`}`),
});

export const fakeDesktop = (): FakeDesktop => {
    const state: FakeState = { calls: [], windows: [], clipboard: "", shade: 200, elements: [] };
    const desktop: Desktop = { ...screenMethods(state), ...inputMethods(state), ...appMethods(state), ...elementMethods(state) };
    // The state itself is what the test holds, so a change it makes is what the next call reads.
    return Object.assign(state, { desktop });
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

// --- Android over adb ---------------------------------------------------------------------------------------------------

// A dump node as uiautomator writes it: every attribute present, false unless given.
export const uiNode = (attributes: Record<string, string>, children: readonly string[] = []): string => {
    const all = {
        index: "0",
        text: "",
        "resource-id": "",
        class: "android.view.View",
        package: "com.example.app",
        "content-desc": "",
        checkable: "false",
        checked: "false",
        clickable: "false",
        enabled: "true",
        focusable: "false",
        focused: "false",
        scrollable: "false",
        "long-clickable": "false",
        password: "false",
        selected: "false",
        bounds: "[0,0][1080,2400]",
        ...attributes,
    };
    const open = `<node ${Object.entries(all)
        .map(([name, value]) => `${name}="${value}"`)
        .join(" ")}`;
    return children.length === 0 ? `${open} />` : `${open}>${children.join("")}</node>`;
};

export const uiDump = (rotation: number, ...nodes: string[]): string =>
    `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="${rotation}">${nodes.join("")}</hierarchy>UI hierchary dumped to: /dev/tty\n`;

// A settings screen: a scrolling list with a row named by its two lines, a switch, an icon button with only an id, a
// search field, a plain label, and a node with no place on the screen.
export const SETTINGS_DUMP = uiDump(
    0,
    uiNode({ class: "android.widget.FrameLayout" }, [
        uiNode(
            {
                class: "androidx.recyclerview.widget.RecyclerView",
                "resource-id": "com.android.settings:id/recycler_view",
                scrollable: "true",
                focusable: "true",
                bounds: "[0,200][1080,2400]",
            },
            [
                uiNode({ class: "android.widget.LinearLayout", clickable: "true", focusable: "true", bounds: "[0,200][1080,400]" }, [
                    uiNode({
                        class: "android.widget.TextView",
                        text: "Network &amp; internet",
                        "resource-id": "android:id/title",
                        bounds: "[40,220][600,300]",
                    }),
                    uiNode({
                        class: "android.widget.TextView",
                        text: "Wi&#8209;Fi, &quot;mobile&quot;",
                        "resource-id": "android:id/summary",
                        bounds: "[40,300][600,380]",
                    }),
                ]),
                uiNode({
                    class: "android.widget.Switch",
                    "resource-id": "com.android.settings:id/switch_widget",
                    checkable: "true",
                    checked: "true",
                    clickable: "true",
                    bounds: "[900,420][1040,500]",
                }),
                uiNode({
                    class: "android.widget.ImageButton",
                    "resource-id": "com.example.app:id/fab",
                    clickable: "true",
                    bounds: "[880,2100][1040,2260]",
                }),
                uiNode({
                    class: "android.widget.EditText",
                    "resource-id": "com.example.app:id/search",
                    clickable: "true",
                    focusable: "true",
                    focused: "true",
                    bounds: "[40,520][1040,620]",
                }),
                uiNode({ class: "android.widget.TextView", text: "Version 1.0", bounds: "[40,700][400,760]" }),
                uiNode({ class: "android.widget.TextView", text: "offscreen", bounds: "[0,0][0,0]" }),
            ],
        ),
    ]),
);

// A phone's screen as screencap sends it: one grey, so a change of shade is a change of screen.
export const phonePng = (width: number, height: number, shade: number): Buffer => solidPng(width, height, shade);

export interface FakeAdb {
    readonly run: AdbRunner;
    // Every invocation's argv, in order, joined with spaces so a test reads as a transcript.
    readonly calls: string[];
}

// adb that answers from `respond`, by argv; anything it does not answer exits 0 with no output.
export const fakeAdb = (respond: (args: readonly string[]) => Partial<AdbOutput> | undefined): FakeAdb => {
    const calls: string[] = [];
    return {
        calls,
        run: async (args) => {
            calls.push(args.join(" "));
            return { code: 0, stdout: Buffer.alloc(0), stderr: "", timedOut: false, ...respond(args) };
        },
    };
};
