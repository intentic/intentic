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
    // Deltas in the page's CSS pixels; what does not make a whole notch is kept for the next one.
    readonly wheel: (x: number, y: number, deltaX: number, deltaY: number) => void;
    // One keysym, with modifiers already folded in ("ctrl+a", "Return", "shift+End").
    readonly key: (chord: string) => void;
    readonly type: (text: string) => void;
    // Lets go of every button still held first: a viewer gone mid-drag would leave it down for the next one.
    readonly stop: () => void;
}

// DOM buttons (0/1/2) map to X's (1/2/3) by table, not increment; 4/5 are the wheel, 8/9 back/forward.
const X_BUTTON = [1, 2, 3, 8, 9] as const;
export const xButton = (button: number | undefined): number => X_BUTTON[button ?? 0] ?? 1;

// Wheel notch size: Chromium scrolls ~53px per click. X has no smaller step, so what a delta leaves short of a notch is
// carried into the next one: a trackpad's few pixels at a time add up to a notch instead of scrolling nothing.
const WHEEL_STEP = 53;
// Caps a single event's presses, so a fling or a page reporting deltas in pages doesn't wedge the pipe; what is past the
// cap is not carried, or one fling would keep scrolling long after it ended.
const WHEEL_MAX = 12;

// One axis of wheel notches: whole presses, signed by direction, and what is left over for the next delta.
export interface WheelNotches {
    readonly presses: number;
    readonly carry: number;
}

// The delta with what the last one left over, as notches.
export const wheelNotches = (carried: number, delta: number): WheelNotches => {
    const total = carried + delta;
    const whole = Math.trunc(total / WHEEL_STEP);
    const presses = Math.min(WHEEL_MAX, Math.abs(whole));
    return { presses: whole < 0 ? -presses : presses, carry: presses < Math.abs(whole) ? 0 : total - whole * WHEEL_STEP };
};

// xdotool speaks lines; anything that could carry a newline is split before it gets here, so a command can't be forged.
const line = (parts: readonly (string | number)[]): string => `${parts.join(" ")}\n`;

// One line of text as the lines that type it. `xdotool -` is not an argv: it splits a line into words, joins a `type`'s
// words with nothing between them (so every space vanishes), and reads a word that begins with `$` as the name of an
// environment variable (quitting when there is none). Measured on xdotool 3.20160805 with xev recording what each line
// typed: inside single quotes a word is literal, whatever it holds but a single quote, which has no escape and so is a
// double-quoted word of its own, and a `$` is pressed as a key where it could begin a word. `--` ends the option list,
// so text that starts with a dash is typed rather than parsed.
const typedLines = (text: string): string[] =>
    text.split("$").flatMap((run, index) => {
        const typed =
            run === ""
                ? []
                : [
                      line([
                          "type",
                          "--clearmodifiers",
                          "--",
                          ...run.split("'").flatMap((piece, at) => [...(at > 0 ? [`"'"`] : []), ...(piece === "" ? [] : [`'${piece}'`])]),
                      ]),
                  ];
        return index === 0 ? typed : [line(["key", "--clearmodifiers", "dollar"]), ...typed];
    });

// Gestures over any writer, separate from the process that usually receives them: what matters here is the text itself
// (button numbers, wheel presses, never forging a command from a newline), none of which needs owning a child process.
export const xInputOver = (write: (command: string) => void, stop: () => void): XInput => {
    // Every event names its point: X's pointer is one shared location, and a press without one lands wherever it was
    // last left. Never `--sync`: it waits 15 s for the pointer to leave a point it already holds, which a press always
    // is; one connection replays the move before the press anyway.
    const at = (x: number, y: number, ...rest: readonly (string | number)[]): void =>
        write(line(["mousemove", Math.round(x), Math.round(y), ...rest]));
    // What a wheel left short of a notch on each axis, and the buttons pressed and not yet released, by X number, with
    // where the pointer was.
    const carry = { x: 0, y: 0 };
    const held = new Set<number>();
    let last = { x: 0, y: 0 };

    return {
        move: (x, y) => {
            last = { x, y };
            at(x, y);
        },
        down: (x, y, button) => {
            last = { x, y };
            held.add(xButton(button));
            at(x, y, "mousedown", xButton(button));
        },
        up: (x, y, button) => {
            last = { x, y };
            held.delete(xButton(button));
            at(x, y, "mouseup", xButton(button));
        },
        wheel: (x, y, deltaX, deltaY) => {
            // A press and a release, not `click`, which sleeps 100 ms after every one; a fling is up to WHEEL_MAX of them.
            const press = (button: number, count: number): void => {
                for (let index = 0; index < count; index++) {
                    at(x, y, "mousedown", button, "mouseup", button);
                }
            };
            const vertical = wheelNotches(carry.y, deltaY);
            const horizontal = wheelNotches(carry.x, deltaX);
            carry.y = vertical.carry;
            carry.x = horizontal.carry;
            // Buttons 4/5 are vertical (up/down), 6/7 horizontal (left/right).
            press(vertical.presses < 0 ? 4 : 5, Math.abs(vertical.presses));
            press(horizontal.presses < 0 ? 6 : 7, Math.abs(horizontal.presses));
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
                typedLines(part).forEach(write);
            });
        },
        stop: () => {
            for (const button of held) {
                at(last.x, last.y, "mouseup", button);
            }
            held.clear();
            stop();
        },
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
