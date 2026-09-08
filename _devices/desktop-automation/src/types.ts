// This package takes coordinates and text and moves a device; it knows nothing about agents, capabilities, or
// permission checks, which happen before these are called. Depending on this interface rather than a concrete
// backend is what makes the layer above testable.

export interface Point {
    readonly x: number;
    readonly y: number;
}

export type MouseButton = "left" | "right" | "middle";
export type ScrollDirection = "up" | "down" | "left" | "right";

// origin is the top-left of the virtual desktop in OS coordinates, not always (0,0) with multi-monitor setups;
// backends add it so callers work in screenshot pixels throughout.
export interface ScreenFrame {
    readonly width: number;
    readonly height: number;
    readonly origin: Point;
}

// bounds share the same screenshot-pixel space as everything else. id is opaque and platform-shaped (HWND, X11
// window id, sway node id); handed back verbatim to focus the window.
export interface WindowInfo {
    readonly id: string;
    readonly title: string;
    // The program as the OS names it ("chrome", "Code", "slack"), not what a person calls it.
    readonly app: string;
    readonly bounds: { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
    readonly focused: boolean;
}

// One object rather than free functions, so a caller can hold a fake.
export interface Desktop {
    // Cheap where the OS answers it directly; a screenshot's own dimensions where it will not (Wayland).
    readonly frame: () => Promise<ScreenFrame>;
    // The screen as a PNG.
    readonly capture: () => Promise<Buffer>;
    readonly move: (to: Point) => Promise<void>;
    readonly click: (at: Point, button: MouseButton) => Promise<void>;
    readonly doubleClick: (at: Point) => Promise<void>;
    readonly drag: (from: Point, to: Point) => Promise<void>;
    // Types literal text, no key names or escapes; newlines become Enter.
    readonly type: (text: string) => Promise<void>;
    // One chord in this package's vocabulary (see keys.ts), e.g. "ctrl+c", "alt+Tab", "F5".
    readonly key: (combo: string) => Promise<void>;
    readonly scroll: (at: Point, direction: ScrollDirection, amount: number) => Promise<void>;
    // Every window a person could switch to, most-recently-used first where the platform reports that order.
    readonly windows: () => Promise<WindowInfo[]>;
    // Brings a window to the front and gives it the keyboard; call before `type`.
    readonly focusWindow: (id: string) => Promise<void>;
    // Starts an application, or opens a URL/file with whatever the machine has registered for it.
    readonly launch: (target: string) => Promise<void>;
    readonly readClipboard: () => Promise<string>;
    readonly writeClipboard: (text: string) => Promise<void>;
}

// Thrown rather than returned, so every call site handles it the same way. `install` carries a one-line remedy
// when the cause is a missing program, kept separate from the message.
export class DesktopError extends Error {
    readonly install: string | undefined;
    constructor(message: string, install?: string) {
        super(message);
        this.name = "DesktopError";
        this.install = install;
    }
}
