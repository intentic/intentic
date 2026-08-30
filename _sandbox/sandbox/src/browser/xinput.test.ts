import { describe, expect, test } from "vitest";
import { chordOf } from "./live-view.js";
import { xButton, xInputOver } from "./xinput.js";

/* WHAT THE OWNER'S HANDS BECOME, as lines on a pipe.
 *
 * xdotool is driven over stdin rather than a process per event, so every gesture is text — and text on a
 * line-oriented protocol is a thing that can be forged. The last test here is the one that matters: a paste
 * carrying a newline must never be able to end the `type` command and start a command of its own.
 *
 * Driven through `xInputOver` rather than the real `startXInput`, which is why this is a unit test and not an
 * integration one: the gestures are the whole subject, the process that usually receives them is not, and a
 * recorder in its place needs no child, no display and no mocking of node's own modules.
 */

// Every line the input wrote, in order.
const driven = (act: (input: ReturnType<typeof xInputOver>) => void): string[] => {
    const written: string[] = [];
    act(xInputOver((command) => written.push(command), () => {}));
    return written;
};

describe("xButton", () => {
    /* NOT AN OFFSET, A DIFFERENT ORDER. The DOM counts 0 left, 1 middle, 2 right; X counts 1 left, 2 middle,
     * 3 right. Incrementing would send a middle-click for every right-click — which on a page means a link
     * opened in a new tab instead of a context menu, and no error anywhere. */
    test("DOM button numbers become X ones", () => {
        expect([0, 1, 2].map((button) => xButton(button))).toEqual([1, 2, 3]);
    });

    test("a mouse with side buttons keeps them, and anything unknown is the main button", () => {
        expect([xButton(3), xButton(4)]).toEqual([8, 9]);
        expect([xButton(undefined), xButton(99)]).toEqual([1, 1]);
    });
});

describe("chordOf", () => {
    // Most DOM key names are already X keysyms. Return is the one that is not, and it is also the one every
    // form needs, so getting it wrong means no sign-in anywhere.
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

    /* EVERY POINTER COMMAND CARRIES THE POSITION because X's pointer is one shared thing, and a press that does
     * not say where it is presses wherever the pointer was last left — after a reconnect, or a menu that warped
     * it, that is not where the owner is looking. */
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

    // A trackpad fling, or a page reporting its delta in pages rather than pixels, must not become hundreds of
    // presses written to a pipe.
    test("an absurd wheel delta is capped rather than replayed", () => {
        const lines = driven((input) => input.wheel(0, 0, 0, 100_000));

        expect(lines).toHaveLength(12);
    });

    /* THE ONE THAT MATTERS. xdotool reads one command per line, and `type` takes the rest of its line as text.
     * A pasted password, or a page's own content copied out and back in, can contain a newline — and if it were
     * written through unescaped, everything after it would be read as a COMMAND. So text is split on newlines
     * before it ever reaches the pipe, and the breaks are pressed as Return, which is also what typing them
     * would actually do. */
    test("a newline in typed text becomes a keypress, never a second command", () => {
        const lines = driven((input) => input.type("hello\nkey ctrl+w\nworld"));

        expect(lines).toEqual([
            "type --clearmodifiers -- hello\n",
            "key --clearmodifiers Return\n",
            "type --clearmodifiers -- key ctrl+w\n",
            "key --clearmodifiers Return\n",
            "type --clearmodifiers -- world\n",
        ]);
        // The forged command is typed as text and never issued as one.
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
