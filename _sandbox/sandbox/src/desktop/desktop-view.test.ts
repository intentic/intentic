import type { XInput } from "../browser/cast/xinput.js";
import { DesktopViewMessageSchema, desktopChord, replayPointer } from "./desktop-view.js";

/* The owner's hands on the sandbox desktop: what each event from the editor's view becomes on the X display. */

const recorder = () => {
    const calls: string[] = [];
    const input: XInput = {
        move: (x, y) => void calls.push(`move ${x},${y}`),
        down: (x, y, button) => void calls.push(`down ${x},${y} ${button ?? 0}`),
        up: (x, y, button) => void calls.push(`up ${x},${y} ${button ?? 0}`),
        wheel: (x, y, dx, dy) => void calls.push(`wheel ${x},${y} ${dx},${dy}`),
        key: (chord) => void calls.push(`key ${chord}`),
        type: (text) => void calls.push(`type ${text}`),
        stop: () => undefined,
    };
    return { calls, input };
};

test("pointer events land on the pixel they name, one press per down, and an unmeasured point is dropped", () => {
    const { input, calls } = recorder();
    replayPointer(input, { type: "mouse", action: "move", x: 10.4, y: 20.6 });
    // A double click arrives as two downs and two ups; X counts them as a double click itself.
    for (let press = 0; press < 2; press++) {
        replayPointer(input, { type: "mouse", action: "down", x: 5, y: 5, button: 0 });
        replayPointer(input, { type: "mouse", action: "up", x: 5, y: 5, button: 0 });
    }
    replayPointer(input, { type: "mouse", action: "wheel", x: 1, y: 1, deltaY: 120 });
    replayPointer(input, { type: "mouse", action: "down", x: Number.NaN, y: 3 });
    expect(calls).toEqual(["move 10,21", "down 5,5 0", "up 5,5 0", "down 5,5 0", "up 5,5 0", "wheel 1,1 0,120"]);
});

test("keys arrive in xdotool's names with their modifiers", () => {
    expect(desktopChord({ key: "Enter" })).toBe("Return");
    expect(desktopChord({ key: "a", ctrl: true, shift: true })).toBe("ctrl+shift+a");
    expect(desktopChord({ key: "ArrowLeft", alt: true })).toBe("alt+Left");
    expect(desktopChord({ key: "F5" })).toBe("F5");
    expect(desktopChord({ key: "+", ctrl: true, shift: true })).toBe("ctrl+shift+plus");
    expect(desktopChord({ key: "-", ctrl: true })).toBe("ctrl+minus");
});

test("only well-formed messages are read off the socket", () => {
    expect(DesktopViewMessageSchema.safeParse({ type: "mouse", action: "down", x: 1, y: 2, button: 0 }).success).toBe(true);
    expect(DesktopViewMessageSchema.safeParse({ type: "mouse", action: "down", x: "1", y: 2 }).success).toBe(false);
    expect(DesktopViewMessageSchema.safeParse({ type: "control" }).success).toBe(false);
    expect(DesktopViewMessageSchema.safeParse({ type: "exec", command: "rm -rf /" }).success).toBe(false);
});
