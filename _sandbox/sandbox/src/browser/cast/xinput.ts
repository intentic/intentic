
import { type ChildProcess, spawn } from "node:child_process";
import type { Display } from "./display.js";

/* THE OWNER'S HANDS, AT THE X SERVER RATHER THAN AT THE PAGE.
 *
 * Input used to go in over CDP's Input domain, which delivers an event straight to a page's renderer. That is
 * the right tool for automating a page and the wrong one for handing somebody a browser, because a browser is
 * more than its page and the difference is exactly where the old view fell apart:
 *
 *   - AN OPEN <select> IS NOT IN THE PAGE. Chromium draws it as a native menu in a window of its own, so a CDP
 *     click aimed at the coordinates the list appears at lands on whatever the PAGE has underneath instead. The
 *     old code worked around this by reading the options out of the DOM and drawing a menu in the operator's
 *     own browser — about 250 lines, a component, and a round trip, to reimplement a control that was already
 *     on screen. The same is true of autofill drop-downs, the file picker, print, and every permission prompt.
 *   - THE BROWSER'S OWN CHROME IS NOT IN THE PAGE EITHER. Back, forward, reload and the address bar had to be
 *     drawn in HTML and wired to Playwright calls, because the picture was the page alone.
 *
 * XTEST moves the X server's actual pointer and presses its actual keys, so every one of those is simply
 * clickable — and the cursor in the captured picture is the real one, at the real place, in the shape Chromium
 * gave it. Coordinates are the DISPLAY's, which is the same space the capture is in, so nothing anywhere has to
 * know how tall the browser's chrome is.
 *
 * WHY ONE LONG-LIVED PROCESS. `xdotool` per event would fork and exec per pointer move — 5-10ms of process
 * setup against an event stream that arrives 60 times a second, which is slower than the network it was meant
 * to be hiding. `xdotool -` reads commands from stdin instead, so a session pays for one process and then
 * writes a line per event.
 */

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

/* X BUTTON NUMBERS, from the DOM's. The DOM counts 0 left, 1 middle, 2 right; X counts 1 left, 2 middle,
 * 3 right — not an offset, a different order, which is why this is a table and not an increment. 4 and 5 are
 * the wheel, and 8/9 are back/forward on a mouse that has them. */
const X_BUTTON = [1, 2, 3, 8, 9] as const;
export const xButton = (button: number | undefined): number => X_BUTTON[button ?? 0] ?? 1;

/* HOW FAR ONE WHEEL CLICK SCROLLS, and why a delta has to be divided by something.
 *
 * X has no scroll delta. A wheel is buttons 4 and 5, and "scrolled a lot" is that button pressed several times,
 * so a browser's own notion of how far one press goes is what decides the speed. Chromium's is 53 CSS pixels
 * per click on Linux; a DOM wheel event on the owner's machine reports its delta in whatever unit their OS and
 * browser agreed on, most often ~100 per notch. Dividing by this converts one to the other closely enough that
 * a page scrolls at the speed the hand expects, and the residue is dropped rather than accumulated: a scroll
 * that is off by a third of a notch is invisible, where carried-over state between events is a bug. */
const WHEEL_STEP = 53;
// A single event must not turn into hundreds of button presses. A trackpad fling or a page that reports its
// delta in pages rather than pixels would otherwise wedge this writing to a pipe for a second.
const WHEEL_MAX = 12;

// xdotool speaks lines. Anything that could carry a newline (typed text) is split before it gets here, so a
// command can never be forged out of a page's content or an owner's paste.
const line = (parts: readonly (string | number)[]): string => `${parts.join(" ")}\n`;

/* THE GESTURES, OVER ANY WRITER — separated from the process that usually receives them, and not only for the
 * test. What is worth getting right here is the TEXT: which button number, how many wheel presses, and above
 * all that a pasted newline can never become a second command. None of that is about owning a child process,
 * and tying the two together would mean the only way to check any of it was to spawn something. */
export const xInputOver = (write: (command: string) => void, stop: () => void): XInput => {
    /* WHY EVERY POINTER COMMAND CARRIES THE POSITION. X's pointer has one location, shared by everything on the
     * display, and a press that does not say where it is presses wherever the pointer was left — which after a
     * reconnect, or a menu that warped it, is not where the owner is looking. Naming the point every time makes
     * each event complete in itself, and `mousemove` to a position it is already at costs nothing. */
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
        // --clearmodifiers so a modifier the owner is still physically holding on their own machine, which this
        // end has no way to observe, cannot silently turn every chord into a different one.
        key: (chord) => write(line(["key", "--clearmodifiers", chord])),
        type: (text) => {
            // Split on newlines rather than escaping them: a newline in the middle of a `type` would be read as
            // the end of the command and the start of another, which is the one way a paste could become an
            // instruction. Each line is typed, and the breaks between them are pressed as Return.
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

/* The real one: a long-lived `xdotool -` on that display, lazily started and restarted after a death, because
 * the alternative is a window whose keyboard silently stopped working. */
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
