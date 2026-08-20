/* Driving a desktop, as an interface. Nothing in this package knows about agents, capabilities, scopes or
 * sandboxes: it takes coordinates and text and makes a computer do something. Whether an action is ALLOWED is
 * somebody else's question, asked before these are ever called.
 *
 * That separation is what makes this testable at all. The mechanics are unmockable by nature, they end in a
 * real pointer moving on a real screen, so the only way to test the layer above is for the layer above to
 * depend on this interface rather than on `xdotool`. */

export interface Point {
    readonly x: number;
    readonly y: number;
}

export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";

/* The screen the coordinates are IN. `origin` is the top-left of the virtual desktop in the OS's own coordinate
 * space, which is not always (0,0): a second monitor placed to the left of the primary one gives Windows a
 * negative virtual left edge, and a screenshot's pixel (0,0) is that corner rather than the origin the pointer
 * API expects. Backends add it back, so a caller works in screenshot pixels throughout and multi-monitor setups
 * stop being a source of silent misclicks. */
export interface ScreenFrame {
    readonly width: number;
    readonly height: number;
    readonly origin: Point;
}

/* One open window. The bounds are in the same screenshot-pixel space as everything else, so "click the middle of
 * the Slack window" is arithmetic rather than a guess, which is most of why listing windows is worth having at
 * all, beyond knowing what is open.
 *
 * `id` is opaque and platform-shaped (an HWND on Windows, an X11 window id, a sway node id). It is handed back
 * verbatim to focus a window and is not meaningful to anyone else. */
export interface WindowInfo {
    readonly id: string;
    readonly title: string;
    // The program, as the OS names it, "chrome", "Code", "slack". What a person means by "the browser".
    readonly app: string;
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly focused: boolean;
}

// What a desktop can be asked to do. One object rather than free functions so a caller can hold a fake.
export interface Desktop {
    // The current reference frame. Cheap where the OS will answer it, a screenshot's own dimensions where it
    // will not (Wayland).
    readonly frame: () => Promise<ScreenFrame>;
    // The screen as a PNG.
    readonly capture: () => Promise<Buffer>;
    readonly move: (to: Point) => Promise<void>;
    readonly click: (at: Point, button: MouseButton) => Promise<void>;
    readonly doubleClick: (at: Point) => Promise<void>;
    readonly drag: (from: Point, to: Point) => Promise<void>;
    // Types literal text, no key names, no escapes the caller has to know. Newlines are Enter.
    readonly type: (text: string) => Promise<void>;
    // One chord in this package's vocabulary (see keys.ts): "Return", "ctrl+c", "alt+Tab", "F5".
    readonly key: (combo: string) => Promise<void>;
    readonly scroll: (at: Point, direction: ScrollDirection, amount: number) => Promise<void>;
    /* Every window a person could switch to, most-recently-used first where the platform says so. This is what
     * turns pixel-pushing into operating an application: without it a caller cannot tell what is open, cannot
     * know which window its typing will land in, and cannot find the thing it means to click. */
    readonly windows: () => Promise<WindowInfo[]>;
    // Bring a window to the front and give it the keyboard. The call every `type` should be preceded by.
    readonly focusWindow: (id: string) => Promise<void>;
    /* Start an application, or open a URL or file with whatever the machine has registered for it. Separate from
     * running a command because "open this in the browser" should not require the caller to know that it is
     * `xdg-open` here and `Start-Process` there, and because it is the first step of most tasks. */
    readonly launch: (target: string) => Promise<void>;
    readonly readClipboard: () => Promise<string>;
    readonly writeClipboard: (text: string) => Promise<void>;
}

/* A desktop that cannot do the thing, with a sentence naming what would fix it. Thrown rather than returned
 * because every call site treats it the same way, surface the message, and because the alternative is a
 * result type threaded through nine methods that succeed in the ordinary case.
 *
 * `install` carries the one-line remedy when the cause is a missing program, which on Linux it usually is. It is
 * separate from the message so a caller can present it as an action rather than prose. */
export class DesktopError extends Error {
    readonly install: string | undefined;
    constructor(message: string, install?: string) {
        super(message);
        this.name = "DesktopError";
        this.install = install;
    }
}
