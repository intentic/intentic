import { describe, expect, test } from "vitest";
import { chordOf } from "./live-view.js";
import { xButton, xInputOver } from "./xinput.js";

// Gestures become lines on a pipe to xdotool, which makes them forgeable text; the newline test matters most, since a
// paste must never start a command. Driven through `xInputOver`, not `startXInput`, so this needs no child process or
// display.

// Every line the input wrote, in order.
const driven = (act: (input: ReturnType<typeof xInputOver>) => void): string[] => {
    const written: string[] = [];
    act(xInputOver((command) => written.push(command), () => {}));
    return written;
};

describe("xButton", () => {
    // DOM and X order buttons differently (0/1/2 left/middle/right vs 1/2/3); incrementing would silently send a
    // middle-click for a right-click.
    test("DOM button numbers become X ones", () => {
        expect([0, 1, 2].map((button) => xButton(button))).toEqual([1, 2, 3]);
    });

    test("a mouse with side buttons keeps them, and anything unknown is the main button", () => {
        expect([xButton(3), xButton(4)]).toEqual([8, 9]);
        expect([xButton(undefined), xButton(99)]).toEqual([1, 1]);
    });
});

describe("chordOf", () => {
    test("the keys whose names differ are translated and the rest pass through", () => {
        expect(chordOf({ key: "Enter" })).toBe("Return");
        expect(chordOf({ key: "Backspace" })).toBe("BackSpace");
        expect(chordOf({ key: "ArrowLeft" })).toBe("ArrowLeft");
    });

    test("modifiers ride in front, in the order xdotool spells them", () => {
        expect(chordOf({ key: "a", ctrl: true })).toBe("ctrl+a");
        expect(chordOf({ key: "End", shift: true })).toBe("shift+End");
        expect(chordOf({ key: "z", ctrl: true, shift: true })).toBe("ctrl+shift+z");
    });
});

describe("xInputOver", () => {
    test("a pointer event names the point it happened at", () => {
        const lines = driven((input) => {
            input.move(100, 200);
            input.down(100, 200, 0);
            input.up(100, 200, 0);
        });

        expect(lines).toEqual(["mousemove --sync 100 200\n", "mousemove --sync 100 200 mousedown 1\n", "mousemove --sync 100 200 mouseup 1\n"]);
    });

    test("coordinates are rounded, because X has no fractional pixels", () => {
        const lines = driven((input) => input.move(100.4, 200.6));

        expect(lines).toEqual(["mousemove --sync 100 201\n"]);
    });

    // X has no scroll delta: a wheel is a button pressed once per notch, so a delta has to become a count.
    test("a wheel delta becomes wheel-button presses in the right direction", () => {
        const down = driven((input) => input.wheel(10, 20, 0, 106));
        const up = driven((input) => input.wheel(10, 20, 0, -53));

        expect(down).toEqual(["mousemove --sync 10 20 click 5\n", "mousemove --sync 10 20 click 5\n"]);
        expect(up).toEqual(["mousemove --sync 10 20 click 4\n"]);
    });

    // Capped at WHEEL_MAX so a trackpad fling or a page reporting deltas in pages doesn't write hundreds of presses.
    test("an absurd wheel delta is capped rather than replayed", () => {
        const lines = driven((input) => input.wheel(0, 0, 0, 100_000));

        expect(lines).toHaveLength(12);
    });

    // xdotool reads one command per line, and `type` takes the rest of its line as text; an unescaped newline would let
    // everything after it be read as a new command. Breaks are pressed as Return, matching what typing them would
    // actually do.
    test("a newline in typed text becomes a keypress, never a second command", () => {
        const lines = driven((input) => input.type("hello\nkey ctrl+w\nworld"));

        expect(lines).toEqual([
            "type --clearmodifiers -- hello\n",
            "key --clearmodifiers Return\n",
            "type --clearmodifiers -- key ctrl+w\n",
            "key --clearmodifiers Return\n",
            "type --clearmodifiers -- world\n",
        ]);
        expect(lines).not.toContain("key ctrl+w\n");
    });

    test("every newline style a clipboard can carry is split the same way", () => {
        expect(driven((input) => input.type("a\r\nb"))).toHaveLength(3);
        expect(driven((input) => input.type("a\rb"))).toHaveLength(3);
    });

    // `--` ends the option list, so a password that begins with a dash is typed rather than parsed as a flag.
    test("text that looks like an option is still text", () => {
        expect(driven((input) => input.type("--window 1"))).toEqual(["type --clearmodifiers -- --window 1\n"]);
    });
});
