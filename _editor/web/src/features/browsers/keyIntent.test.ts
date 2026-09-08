// Every keystroke over a live browser picture goes to exactly one of two places (host or remote page); each case
// here is one half of that split, and what stays with the host matters as much as what's forwarded.
import { describe, expect, test } from "vitest";
import { keyIntent } from "./keyIntent";

// A keydown as the host reports it; only the fields the decision reads.
const press = (key: string, held: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}): KeyboardEvent =>
    ({
        key,
        ctrlKey: held.ctrl === true,
        metaKey: held.meta === true,
        shiftKey: held.shift === true,
        altKey: held.alt === true,
    }) as unknown as KeyboardEvent;

describe("typing", () => {
    test("a character is inserted rather than synthesized as a keystroke", () => {
        expect(keyIntent(press(`k`))).toEqual({ kind: `text`, text: `k` });
        // Shift is already applied to the reported character, so a capital needs nothing extra.
        expect(keyIntent(press(`K`, { shift: true }))).toEqual({ kind: `text`, text: `K` });
    });

    test("the control keys a form needs are sent as keystrokes", () => {
        expect(keyIntent(press(`Enter`))).toEqual({ kind: `key`, frame: { type: `key`, key: `Enter` } });
        expect(keyIntent(press(`Tab`))).toEqual({ kind: `key`, frame: { type: `key`, key: `Tab` } });
    });

    // Shift already reached arrow keys, just without the flag: it moved the caret instead of extending a selection,
    // the wrong thing rather than nothing.
    test("shift travels with an arrow, or a selection collapses into a caret move", () => {
        expect(keyIntent(press(`ArrowLeft`, { shift: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `ArrowLeft`, shift: true } });
        expect(keyIntent(press(`End`, { shift: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `End`, shift: true } });
    });

    test("a key that is neither text nor a control key is nobody's", () => {
        expect(keyIntent(press(`F1`))).toEqual({ kind: `host` });
    });
});

describe("editing chords", () => {
    test("select all reaches the page, the whole point", () => {
        expect(keyIntent(press(`a`, { ctrl: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `a`, ctrl: true } });
    });

    // A Mac's Cmd is the same chord as Ctrl in a person's hands, and the remote browser is Linux where Meta means
    // nothing, so it's sent as ctrl.
    test("command on a Mac is control on the wire", () => {
        expect(keyIntent(press(`a`, { meta: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `a`, ctrl: true } });
    });

    test("undo, redo and the rich-text trio go too", () => {
        expect(keyIntent(press(`z`, { ctrl: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `z`, ctrl: true } });
        expect(keyIntent(press(`Z`, { ctrl: true, shift: true }))).toEqual({
            kind: `key`,
            frame: { type: `key`, key: `z`, ctrl: true, shift: true },
        });
        expect(keyIntent(press(`b`, { ctrl: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `b`, ctrl: true } });
    });

    test("word-wise motion and word delete are chords on a control key", () => {
        expect(keyIntent(press(`ArrowRight`, { ctrl: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `ArrowRight`, ctrl: true } });
        expect(keyIntent(press(`Backspace`, { ctrl: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `Backspace`, ctrl: true } });
    });
});

describe("the clipboard", () => {
    // Copy/cut round-trip since the selection has to land in the clipboard of the machine the person is sitting at,
    // not the sandbox's.
    test("copy and cut are a round trip, not a forward", () => {
        expect(keyIntent(press(`c`, { ctrl: true }))).toEqual({ kind: `clipboard`, frame: { type: `key`, key: `c`, ctrl: true } });
        expect(keyIntent(press(`x`, { ctrl: true }))).toEqual({ kind: `clipboard`, frame: { type: `key`, key: `x`, ctrl: true } });
    });

    // Left alone deliberately: forwarding it would paste the sandbox's own clipboard instead of the host's real one,
    // silently breaking password paste.
    test("paste stays with the host, whose clipboard is the real one", () => {
        expect(keyIntent(press(`v`, { ctrl: true }))).toEqual({ kind: `host` });
        expect(keyIntent(press(`v`, { meta: true }))).toEqual({ kind: `host` });
    });
});

describe("what the host keeps", () => {
    // These are lost either way: a remote page driven this way ignores window-level chords, so taking them only costs
    // the user their own browser.
    test("window shortcuts are not the page's to take", () => {
        for (const key of [`t`, `w`, `n`, `r`, `f`, `p`, `s`]) {
            expect(keyIntent(press(key, { ctrl: true }))).toEqual({ kind: `host` });
        }
        expect(keyIntent(press(`F5`))).toEqual({ kind: `host` });
    });

    // Shift moves a letter chord into the browser's own territory (devtools, reopen tab, incognito); `i` sits in both
    // worlds (Ctrl+I italicizes, Ctrl+Shift+I opens devtools), and redo is the exception that stays on the page.
    test("shifted letter chords are the browser's, redo excepted", () => {
        expect(keyIntent(press(`I`, { ctrl: true, shift: true }))).toEqual({ kind: `host` });
        expect(keyIntent(press(`T`, { ctrl: true, shift: true }))).toEqual({ kind: `host` });
        expect(keyIntent(press(`C`, { ctrl: true, shift: true }))).toEqual({ kind: `host` });
        expect(keyIntent(press(`Z`, { ctrl: true, shift: true }))).toEqual({
            kind: `key`,
            frame: { type: `key`, key: `z`, ctrl: true, shift: true },
        });
    });

    // Shift with a control key is still a selection, not a browser shortcut, so it must reach the page.
    test("shift still reaches the page on the control keys", () => {
        expect(keyIntent(press(`ArrowLeft`, { ctrl: true, shift: true }))).toEqual({
            kind: `key`,
            frame: { type: `key`, key: `ArrowLeft`, ctrl: true, shift: true },
        });
    });

    test("alt chords belong to the host's own menus and history", () => {
        expect(keyIntent(press(`ArrowLeft`, { alt: true }))).toEqual({ kind: `host` });
        expect(keyIntent(press(`a`, { ctrl: true, alt: true }))).toEqual({ kind: `host` });
    });
});
