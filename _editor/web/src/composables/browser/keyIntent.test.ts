/* WHOSE KEYBOARD IS IT. Every keystroke over a live browser picture goes to exactly one of two places, and the
 * bug this module was written for is what happens when the split is drawn in the wrong place: Ctrl+A used to be
 * left to the host, where it selected the whole of Intentic instead of the field the person was looking at.
 *
 * So each case here is one half of that decision, and the ones left to the HOST matter as much as the ones sent
 * on — a window that swallowed Ctrl+W or Ctrl+V would be a worse bug than the one it fixed. */
import { describe, expect, test } from "vitest";
import { keyIntent } from "./keyIntent";

// A keydown as the host browser reports it. Only the fields the decision reads.
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
        // Shift is already applied to the character the host reported, so a capital needs nothing extra.
        expect(keyIntent(press(`K`, { shift: true }))).toEqual({ kind: `text`, text: `K` });
    });

    test("the control keys a form needs are sent as keystrokes", () => {
        expect(keyIntent(press(`Enter`))).toEqual({ kind: `key`, frame: { type: `key`, key: `Enter` } });
        expect(keyIntent(press(`Tab`))).toEqual({ kind: `key`, frame: { type: `key`, key: `Tab` } });
    });

    /* THE QUIET HALF OF THE SAME BUG. Arrow keys were forwarded already, so Shift+ArrowLeft did reach the page —
     * with the Shift dropped, where it moved the caret instead of extending a selection. Doing the wrong thing
     * rather than nothing, which is the harder kind to notice. */
    test("shift travels with an arrow, or a selection collapses into a caret move", () => {
        expect(keyIntent(press(`ArrowLeft`, { shift: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `ArrowLeft`, shift: true } });
        expect(keyIntent(press(`End`, { shift: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `End`, shift: true } });
    });

    test("a key that is neither text nor a control key is nobody's", () => {
        expect(keyIntent(press(`F1`))).toEqual({ kind: `host` });
    });
});

describe("editing chords", () => {
    test("select all reaches the page — the whole point", () => {
        expect(keyIntent(press(`a`, { ctrl: true }))).toEqual({ kind: `key`, frame: { type: `key`, key: `a`, ctrl: true } });
    });

    // A Mac's ⌘ is the same chord in a person's hands, and the browser at the far end is a Linux one where Meta
    // means nothing — so it travels as ctrl rather than as a modifier that would be ignored on arrival.
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
    // Copy and cut need the round trip: the selection has to come back and be written to the clipboard of the
    // machine the person is sitting at, because the one they'd otherwise reach is inside the sandbox.
    test("copy and cut are a round trip, not a forward", () => {
        expect(keyIntent(press(`c`, { ctrl: true }))).toEqual({ kind: `clipboard`, frame: { type: `key`, key: `c`, ctrl: true } });
        expect(keyIntent(press(`x`, { ctrl: true }))).toEqual({ kind: `clipboard`, frame: { type: `key`, key: `x`, ctrl: true } });
    });

    /* PASTE IS THE ONE CHORD DELIBERATELY LEFT ALONE. Forwarding it would paste whatever the sandbox's Chromium
     * last copied rather than what the person meant; leaving it produces a paste event on the host carrying the
     * real clipboard, which each surface turns into an insert. Swallowing it here would silently break every
     * sign-in that pastes a password. */
    test("paste stays with the host, whose clipboard is the real one", () => {
        expect(keyIntent(press(`v`, { ctrl: true }))).toEqual({ kind: `host` });
        expect(keyIntent(press(`v`, { meta: true }))).toEqual({ kind: `host` });
    });
});

describe("what the host keeps", () => {
    // These would be lost either way — a remote page driven this way ignores window-level chords — so taking
    // them would only cost the user their own browser.
    test("window shortcuts are not the page's to take", () => {
        for (const key of [`t`, `w`, `n`, `r`, `f`, `p`, `s`]) {
            expect(keyIntent(press(key, { ctrl: true }))).toEqual({ kind: `host` });
        }
        expect(keyIntent(press(`F5`))).toEqual({ kind: `host` });
    });

    /* Adding Shift moves a letter chord into the browser's own territory — devtools, reopen tab, incognito —
     * and `i` sits in both worlds: Ctrl+I italicizes, Ctrl+Shift+I opens devtools. Redo is the exception the
     * caret keeps. */
    test("shifted letter chords are the browser's, redo excepted", () => {
        expect(keyIntent(press(`I`, { ctrl: true, shift: true }))).toEqual({ kind: `host` });
        expect(keyIntent(press(`T`, { ctrl: true, shift: true }))).toEqual({ kind: `host` });
        expect(keyIntent(press(`C`, { ctrl: true, shift: true }))).toEqual({ kind: `host` });
        expect(keyIntent(press(`Z`, { ctrl: true, shift: true }))).toEqual({
            kind: `key`,
            frame: { type: `key`, key: `z`, ctrl: true, shift: true },
        });
    });

    // But Shift with a control key is a selection, not a browser shortcut — that half has to survive.
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
