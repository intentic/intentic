
import { type ChildProcess, spawn } from "node:child_process";
import type { Display } from "./display.js";

// Input moves the X server's pointer and keys, not CDP's Input domain, since a browser is more than its page:
// - an open <select>, autofill, the file picker and permission prompts are native menus outside the page.
// - the browser's own chrome (back, forward, the address bar) isn't in the page either.
// XTEST makes it all clickable in the capture's own coordinate space; one xdotool process reads commands from stdin.

export interface XInput {
    readonly move: (x: number, y: number) => void;
    // `button` is the DOM's numbering, translated by xButton below; absent means the main button.
    readonly down: (x: number, y: number, button: number | undefined) => void;
    readonly up: (x: number, y: number, button: number | undefined) => void;
    readonly wheel: (x: number, y: number, deltaX: number, deltaY: number) => void;
    // One keysym, with modifiers already folded in ("ctrl+a", "Return", "shift+End").
    readonly key: (chord: string) => void;
    readonly type: (text: string) => void;
    readonly stop: () => void;
}

// DOM buttons (0/1/2) map to X's (1/2/3) by table, not increment; 4/5 are the wheel, 8/9 back/forward.
const X_BUTTON = [1, 2, 3, 8, 9] as const;
export const xButton = (button: number | undefined): number => X_BUTTON[button ?? 0] ?? 1;

// Wheel notch size: Chromium scrolls ~53px per click; a converted delta's residue is dropped, not accumulated.
const WHEEL_STEP = 53;
// Caps a single event's presses, so a fling or a page reporting deltas in pages doesn't wedge the pipe.
const WHEEL_MAX = 12;

// xdotool speaks lines; anything that could carry a newline is split before it gets here, so a command can't be forged.
const line = (parts: readonly (string | number)[]): string => `${parts.join(" ")}\n`;

// Gestures over any writer, separate from the process that usually receives them: what matters here is the text itself
// (button numbers, wheel presses, never forging a command from a newline), none of which needs owning a child process.
export const xInputOver = (write: (command: string) => void, stop: () => void): XInput => {
    // X's pointer is one shared location; a press with no position lands wherever it was last left, after a reconnect
    // or a warp. Naming the point every time makes each event self-contained; redundant moves cost nothing.
    const at = (x: number, y: number, ...rest: readonly (string | number)[]): void =>
        write(line(["mousemove", "--sync", Math.round(x), Math.round(y), ...rest]));

    return {
        move: (x, y) => at(x, y),
        down: (x, y, button) => at(x, y, "mousedown", xButton(button)),
        up: (x, y, button) => at(x, y, "mouseup", xButton(button)),
        wheel: (x, y, deltaX, deltaY) => {
            const clicks = (delta: number): number => Math.min(WHEEL_MAX, Math.round(Math.abs(delta) / WHEEL_STEP));
            const press = (button: number, count: number): void => {
                for (let index = 0; index < count; index++) {
                    at(x, y, "click", button);
                }
            };
            // Buttons 4/5 are vertical (up/down), 6/7 horizontal (left/right).
            press(deltaY < 0 ? 4 : 5, clicks(deltaY));
            press(deltaX < 0 ? 6 : 7, clicks(deltaX));
        },
        // --clearmodifiers, since a modifier the owner still holds on their own machine is invisible here.
        key: (chord) => write(line(["key", "--clearmodifiers", chord])),
        type: (text) => {
            // Splits on newlines rather than escaping, since a newline mid-`type` would end the command and start
            // another.
            const lines = text.split(/\r\n|\r|\n/u);
            lines.forEach((part, index) => {
                if (index > 0) {
                    write(line(["key", "--clearmodifiers", "Return"]));
                }
                if (part !== "") {
                    // `--` ends the option list, so text that starts with a dash is typed rather than parsed.
                    write(line(["type", "--clearmodifiers", "--", part]));
                }
            });
        },
        stop,
    };
};

// The real one: a long-lived `xdotool -` on that display, lazily started and restarted after a death, since the
// alternative is a window whose keyboard silently stopped working.
export const startXInput = (display: Display): XInput => {
    let child: ChildProcess | undefined;
    let stopped = false;

    const write = (command: string): void => {
        if (stopped) {
            return;
        }
        if (child === undefined || child.exitCode !== null || child.killed) {
            // `-` is the flag that makes xdotool read commands from stdin instead of taking one per process.
            child = spawn("xdotool", ["-"], { env: { ...process.env, DISPLAY: display.name }, stdio: ["pipe", "ignore", "ignore"] });
            // ENOENT (xdotool rides the browser pack) and EPIPE both land here; the next write respawns.
            child.on("error", () => {});
            child.stdin?.on("error", () => {});
            child.stdin?.setDefaultEncoding("utf8");
            // Unref'd so a writer nobody is using never keeps the daemon alive on its own.
            child.unref();
        }
        child.stdin?.write(command);
    };

    return xInputOver(write, () => {
        stopped = true;
        try {
            child?.stdin?.end();
            child?.kill();
        } catch {
            // already gone, which is the outcome asked for
        }
        child = undefined;
    });
};
