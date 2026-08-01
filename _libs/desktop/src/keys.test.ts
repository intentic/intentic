import { expect, test } from "vitest";
import { parseChord, windowsChord, wtypeArgs, xdotoolChord } from "./keys.js";
import { DesktopError } from "./types.js";

/* The one part of this package that can be tested without a screen — and the part most likely to be wrong,
 * because it is three translations of the same vocabulary and nothing but a test compares them. */

test("modifiers are recognised by every name a person would reach for", () => {
    expect(parseChord("ctrl+c")).toEqual({ modifiers: ["ctrl"], key: "c" });
    expect(parseChord("Control+c").modifiers).toEqual(["ctrl"]);
    expect(parseChord("cmd+c").modifiers).toEqual(["super"]);
    expect(parseChord("win+e").modifiers).toEqual(["super"]);
    expect(parseChord("option+Tab").modifiers).toEqual(["alt"]);
});

test("named keys are canonicalised, single characters keep their case", () => {
    expect(parseChord("enter").key).toBe("Return");
    expect(parseChord("ESC").key).toBe("Escape");
    expect(parseChord("pageup").key).toBe("Page_Up");
    expect(parseChord("backspace").key).toBe("BackSpace");
    // Shift is a modifier, so the letter is not upper-cased on the way through — "shift+a" and "A" differ.
    expect(parseChord("shift+a").key).toBe("a");
});

// "ctrl++" is zoom-in in most applications; splitting naively would read the key as empty.
test("a chord whose key IS the separator parses", () => {
    expect(parseChord("ctrl++")).toEqual({ modifiers: ["ctrl"], key: "+" });
});

test("a repeated modifier is not pressed twice", () => {
    expect(parseChord("ctrl+control+s").modifiers).toEqual(["ctrl"]);
});

test("nonsense is refused with a sentence naming what is allowed", () => {
    expect(() => parseChord("hyper+x")).toThrow(DesktopError);
    expect(() => parseChord("hyper+x")).toThrow(/ctrl, alt, shift or super/);
    expect(() => parseChord("ctrl+")).toThrow(/no key/);
    expect(() => parseChord("  ")).toThrow(/No key/);
});

test("xdotool gets X11's own spelling back", () => {
    expect(xdotoolChord("ctrl+shift+t")).toBe("ctrl+shift+t");
    expect(xdotoolChord("enter")).toBe("Return");
    expect(xdotoolChord("cmd+e")).toBe("super+e");
});

test("wtype gets flags and a keysym", () => {
    expect(wtypeArgs("ctrl+c")).toEqual(["-M", "ctrl", "-k", "c"]);
    // Wayland's logo key is spelled differently from X11's super, which is exactly the kind of detail a caller
    // should never have to know.
    expect(wtypeArgs("win+e")).toEqual(["-M", "logo", "-k", "e"]);
});

test("windows resolves to virtual-key codes, including the key SendKeys cannot press", () => {
    expect(windowsChord("ctrl+c")).toEqual({ modifiers: [0x11], key: 0x43 });
    expect(windowsChord("enter").key).toBe(0x0d);
    expect(windowsChord("F5").key).toBe(0x74);
    expect(windowsChord("f12").key).toBe(0x7b);
    expect(windowsChord("5").key).toBe(0x35);
    // super+e opens Explorer — the chord that motivated not using SendKeys for keys at all.
    expect(windowsChord("super+e")).toEqual({ modifiers: [0x5b], key: 0x45 });
});

test("windows refuses a key it has no code for, rather than pressing something else", () => {
    expect(() => windowsChord("ctrl+§")).toThrow(DesktopError);
    expect(() => windowsChord("F99")).toThrow(/F1–F24/);
});
