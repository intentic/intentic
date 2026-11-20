// Every keystroke over a live browser picture goes to exactly one of two places (host or remote page); each case
// here is one half of that split, and what stays with the host matters as much as what's forwarded.
import { type KeyIntent, keyIntent } from "./keyIntent";

interface Held {
    readonly ctrl?: boolean;
    readonly meta?: boolean;
    readonly shift?: boolean;
    readonly alt?: boolean;
    // The AltGraph modifier as an engine that reports it does (getModifierState), whatever ctrl and alt say.
    readonly altGraph?: boolean;
}

// A keydown as the host reports it; only the fields the decision reads.
const press = (key: string, held: Held = {}, code?: string): KeyboardEvent =>
    ({
        key,
        code,
        ctrlKey: held.ctrl === true,
        metaKey: held.meta === true,
        shiftKey: held.shift === true,
        altKey: held.alt === true,
        isComposing: false,
        keyCode: 0,
        getModifierState: (name: string) => name === `AltGraph` && held.altGraph === true,
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
        expect(keyIntent(press(`F1`))).toEqual({ kind: `device` });
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
        expect(keyIntent(press(`v`, { ctrl: true }))).toEqual({ kind: `device` });
        expect(keyIntent(press(`v`, { meta: true }))).toEqual({ kind: `device` });
    });
});

describe("the chrome's own verbs", () => {
    // The tabs and the address bar are the client's, so these are answered there and never travel as keystrokes:
    // forwarded, Ctrl+L would focus an omnibox the picture does not show and swallow everything typed after it.
    test("tab, address and navigation chords are commands, not keystrokes", () => {
        expect(keyIntent(press(`t`, { ctrl: true }))).toEqual({ kind: `command`, command: `newTab` });
        expect(keyIntent(press(`w`, { meta: true }))).toEqual({ kind: `command`, command: `closeTab` });
        expect(keyIntent(press(`r`, { ctrl: true }))).toEqual({ kind: `command`, command: `reload` });
        expect(keyIntent(press(`F5`))).toEqual({ kind: `command`, command: `reload` });
        expect(keyIntent(press(`l`, { ctrl: true }))).toEqual({ kind: `command`, command: `address` });
        expect(keyIntent(press(`f`, { ctrl: true }))).toEqual({ kind: `command`, command: `find` });
    });

    test("history goes by alt with an arrow", () => {
        expect(keyIntent(press(`ArrowLeft`, { alt: true }))).toEqual({ kind: `command`, command: `back` });
        expect(keyIntent(press(`ArrowRight`, { alt: true }))).toEqual({ kind: `command`, command: `forward` });
    });

    test("tabs cycle by Ctrl+Tab and Ctrl+PageDown, backwards with Shift or PageUp", () => {
        expect(keyIntent(press(`Tab`, { ctrl: true }))).toEqual({ kind: `command`, command: `nextTab` });
        expect(keyIntent(press(`Tab`, { ctrl: true, shift: true }))).toEqual({ kind: `command`, command: `prevTab` });
        expect(keyIntent(press(`PageDown`, { ctrl: true }))).toEqual({ kind: `command`, command: `nextTab` });
        expect(keyIntent(press(`PageUp`, { ctrl: true }))).toEqual({ kind: `command`, command: `prevTab` });
    });

    // A button or checkbox answers a space keystroke; an inserted character reaches only a text field.
    test("space is a keystroke, not an inserted character", () => {
        expect(keyIntent(press(` `))).toEqual({ kind: `key`, frame: { type: `key`, key: ` ` } });
        expect(keyIntent(press(`PageDown`))).toEqual({ kind: `key`, frame: { type: `key`, key: `PageDown` } });
    });
});

describe("what the host keeps", () => {
    // These are lost either way: a remote page driven this way ignores window-level chords, so taking them only costs
    // the user their own browser.
    test("window shortcuts are not the page's to take", () => {
        for (const key of [`n`, `s`]) {
            expect(keyIntent(press(key, { ctrl: true }))).toEqual({ kind: `device` });
        }
        expect(keyIntent(press(`F11`))).toEqual({ kind: `device` });
    });

    // Shift moves a letter chord into the browser's own territory (devtools, reopen tab, incognito); `i` sits in both
    // worlds (Ctrl+I italicizes, Ctrl+Shift+I opens devtools), and redo is the exception that stays on the page.
    test("shifted letter chords are the browser's, redo excepted", () => {
        expect(keyIntent(press(`N`, { ctrl: true, shift: true }))).toEqual({ kind: `device` });
        expect(keyIntent(press(`O`, { ctrl: true, shift: true }))).toEqual({ kind: `device` });
        expect(keyIntent(press(`Q`, { ctrl: true, shift: true }))).toEqual({ kind: `device` });
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

    test("alt chords other than history belong to the host's own menus", () => {
        expect(keyIntent(press(`f`, { alt: true }))).toEqual({ kind: `device` });
        expect(keyIntent(press(`a`, { ctrl: true, alt: true }))).toEqual({ kind: `device` });
    });
});

// A Mac's text keys, which the Linux page spells with Ctrl and Home/End. Before this, ⌥← in a form went Back.
describe("keys from a Mac", () => {
    // SAFETY: the decision reads only the fields `press` sets, and the physical key a ⌃ letter is matched by.
    const mac = (key: string, held: { ctrl?: boolean; meta?: boolean; shift?: boolean; alt?: boolean } = {}, code = ``): KeyIntent =>
        keyIntent({ ...press(key, held), code } as KeyboardEvent, true);

    test("⌘ with an arrow goes to the edge, ⌥ to the next word, and neither goes Back", () => {
        expect(mac(`ArrowLeft`, { meta: true })).toEqual({ kind: `key`, frame: { type: `key`, key: `Home` } });
        expect(mac(`ArrowDown`, { meta: true, shift: true })).toEqual({ kind: `key`, frame: { type: `key`, key: `End`, ctrl: true, shift: true } });
        expect(mac(`ArrowLeft`, { alt: true })).toEqual({ kind: `key`, frame: { type: `key`, key: `ArrowLeft`, ctrl: true } });
        expect(mac(`ArrowRight`, { alt: true, shift: true })).toEqual({ kind: `key`, frame: { type: `key`, key: `ArrowRight`, ctrl: true, shift: true } });
    });

    test("⌘⌫ deletes to the line's start in two keystrokes, ⌥⌫ a word in one", () => {
        expect(mac(`Backspace`, { meta: true })).toEqual({
            kind: `key`,
            frame: { type: `key`, key: `Home`, shift: true },
            after: { type: `key`, key: `Backspace` },
        });
        expect(mac(`Backspace`, { alt: true })).toEqual({ kind: `key`, frame: { type: `key`, key: `Backspace`, ctrl: true } });
    });

    test("⌘[ and ⌘] go Back and Forward", () => {
        expect([mac(`[`, { meta: true }), mac(`]`, { meta: true })]).toEqual([
            { kind: `command`, command: `back` },
            { kind: `command`, command: `forward` },
        ]);
    });

    test("⌃ with an Emacs letter moves the caret, and the rest of ⌃ stays with the host", () => {
        expect(mac(`a`, { ctrl: true }, `KeyA`)).toEqual({ kind: `key`, frame: { type: `key`, key: `Home` } });
        expect(mac(`e`, { ctrl: true }, `KeyE`)).toEqual({ kind: `key`, frame: { type: `key`, key: `End` } });
        expect(mac(`c`, { ctrl: true }, `KeyC`)).toEqual({ kind: `device` });
    });

    test("a letter Option typed is a character, and ⌘ is still the primary modifier", () => {
        expect(mac(`ą`, { alt: true }, `KeyA`)).toEqual({ kind: `text`, text: `ą` });
        expect(mac(`l`, { meta: true }, `KeyL`)).toEqual({ kind: `command`, command: `address` });
    });
});

// AltGr is how most of Europe types: ą ę ś ł ż ó ń ć ź on a Polish layout, @ and € on a German one. Windows reports it
// as Ctrl and Alt held together, which read as a chord and went to the host, so none of them typed anything.
describe("AltGr", () => {
    test("an AltGr letter on Windows is the character it types, not a Ctrl+Alt chord", () => {
        for (const [letter, code] of [
            [`ą`, `KeyA`],
            [`ę`, `KeyE`],
            [`ś`, `KeyS`],
            [`ł`, `KeyL`],
            [`ż`, `KeyZ`],
            [`ó`, `KeyO`],
            [`ń`, `KeyN`],
            [`ć`, `KeyC`],
            [`ź`, `KeyX`],
        ] as const) {
            expect(keyIntent(press(letter, { ctrl: true, alt: true, altGraph: true }, code), false)).toEqual({ kind: `text`, text: letter });
        }
    });

    test("a capital AltGr letter keeps its Shift", () => {
        expect(keyIntent(press(`Ą`, { ctrl: true, alt: true, shift: true, altGraph: true }, `KeyA`), false)).toEqual({ kind: `text`, text: `Ą` });
    });

    test("German AltGr symbols type, whether or not the engine reports AltGraph", () => {
        expect(keyIntent(press(`@`, { ctrl: true, alt: true, altGraph: true }, `KeyQ`), false)).toEqual({ kind: `text`, text: `@` });
        // The fallback for an engine without the modifier: the key types something other than its own letter.
        expect(keyIntent(press(`€`, { ctrl: true, alt: true }, `KeyE`), false)).toEqual({ kind: `text`, text: `€` });
        expect(keyIntent(press(`{`, { ctrl: true, alt: true }, `Digit7`), false)).toEqual({ kind: `text`, text: `{` });
        expect(keyIntent(press(`ą`, { ctrl: true, alt: true }, `KeyA`), false)).toEqual({ kind: `text`, text: `ą` });
    });

    // Linux reports AltGr as the AltGraph modifier alone, with neither Ctrl nor Alt held.
    test("AltGr on Linux types its character", () => {
        expect(keyIntent(press(`ł`, { altGraph: true }, `KeyL`), false)).toEqual({ kind: `text`, text: `ł` });
    });

    test("a real Ctrl+Alt chord, which types its own key, is still the host's", () => {
        expect(keyIntent(press(`a`, { ctrl: true, alt: true }, `KeyA`), false)).toEqual({ kind: `device` });
        expect(keyIntent(press(`7`, { ctrl: true, alt: true }, `Digit7`), false)).toEqual({ kind: `device` });
        expect(keyIntent(press(`a`, { ctrl: true, alt: true, altGraph: true }, `KeyA`), false)).toEqual({ kind: `device` });
        expect(keyIntent(press(`Delete`, { ctrl: true, alt: true }, `Delete`), false)).toEqual({ kind: `device` });
    });

    test("Option on a Mac types its letter, Shift or not", () => {
        expect(keyIntent(press(`ś`, { alt: true }, `KeyS`), true)).toEqual({ kind: `text`, text: `ś` });
        expect(keyIntent(press(`Ś`, { alt: true, shift: true }, `KeyS`), true)).toEqual({ kind: `text`, text: `Ś` });
    });
});

// An input method owns these keystrokes; what it commits arrives as text on the input sink, so the keydown must be left
// alone (not prevented, not sent) or the IME never sees it.
describe("input methods", () => {
    // SAFETY: `press` builds every field the decision reads; this overrides two of them.
    const composing = (key: string, over: Partial<KeyboardEvent>): KeyboardEvent => ({ ...press(key), ...over }) as KeyboardEvent;

    test("an IME's Process key, an Android keyboard's Unidentified and a dead key are left to the input method", () => {
        expect(keyIntent(press(`Process`), false)).toEqual({ kind: `device` });
        expect(keyIntent(press(`Unidentified`), false)).toEqual({ kind: `device` });
        expect(keyIntent(press(`Dead`), false)).toEqual({ kind: `device` });
        expect(keyIntent(press(`Dead`, { alt: true }, `KeyE`), true)).toEqual({ kind: `device` });
    });

    // Enter confirms a candidate; sent on, it would also submit the remote form.
    test("Enter that confirms a composition is the input method's, not the page's", () => {
        expect(keyIntent(composing(`Enter`, { isComposing: true }), false)).toEqual({ kind: `device` });
        // Safari ends the composition before this keydown, which only its keyCode still marks.
        expect(keyIntent(composing(`Enter`, { keyCode: 229 }), false)).toEqual({ kind: `device` });
    });

    test("an emoji a keyboard sends in one keydown is one character", () => {
        expect(keyIntent(press(`😀`), false)).toEqual({ kind: `text`, text: `😀` });
    });
});

// The browser's own shortcuts: answered by the pane, never by the editor around it (Ctrl+P printed Intentic, Ctrl+−
// zoomed it).
describe("browser shortcuts", () => {
    test("zoom chords zoom the page, on either platform and from the numpad", () => {
        expect(keyIntent(press(`=`, { ctrl: true }, `Equal`), false)).toEqual({ kind: `command`, command: `zoomIn` });
        expect(keyIntent(press(`+`, { ctrl: true, shift: true }, `Equal`), false)).toEqual({ kind: `command`, command: `zoomIn` });
        expect(keyIntent(press(`+`, { ctrl: true }, `NumpadAdd`), false)).toEqual({ kind: `command`, command: `zoomIn` });
        expect(keyIntent(press(`-`, { ctrl: true }, `Minus`), false)).toEqual({ kind: `command`, command: `zoomOut` });
        expect(keyIntent(press(`0`, { ctrl: true }, `Digit0`), false)).toEqual({ kind: `command`, command: `zoomReset` });
        expect(keyIntent(press(`=`, { meta: true }, `Equal`), true)).toEqual({ kind: `command`, command: `zoomIn` });
        expect(keyIntent(press(`-`, { meta: true }, `Minus`), true)).toEqual({ kind: `command`, command: `zoomOut` });
    });

    test("print, bookmarks and reopening a closed tab are the browser's", () => {
        expect(keyIntent(press(`p`, { ctrl: true }), false)).toEqual({ kind: `command`, command: `print` });
        expect(keyIntent(press(`p`, { meta: true }), true)).toEqual({ kind: `command`, command: `print` });
        expect(keyIntent(press(`d`, { ctrl: true }), false)).toEqual({ kind: `command`, command: `bookmark` });
        expect(keyIntent(press(`d`, { meta: true }), true)).toEqual({ kind: `command`, command: `bookmark` });
        // The bookmarks bar, shown or hidden, as Chrome's Ctrl+Shift+B and ⌘⇧B.
        expect(keyIntent(press(`B`, { ctrl: true, shift: true }), false)).toEqual({ kind: `command`, command: `bookmarksBar` });
        expect(keyIntent(press(`B`, { meta: true, shift: true }), true)).toEqual({ kind: `command`, command: `bookmarksBar` });
        expect(keyIntent(press(`T`, { ctrl: true, shift: true }), false)).toEqual({ kind: `command`, command: `reopenTab` });
        expect(keyIntent(press(`T`, { meta: true, shift: true }), true)).toEqual({ kind: `command`, command: `reopenTab` });
    });

    // ⌘H hides the app on a Mac, which is the person's, not the page's.
    test("history and downloads are Ctrl+H and Ctrl+J on a PC, and ⌘H stays the Mac's", () => {
        expect(keyIntent(press(`h`, { ctrl: true }), false)).toEqual({ kind: `command`, command: `history` });
        expect(keyIntent(press(`j`, { ctrl: true }), false)).toEqual({ kind: `command`, command: `downloads` });
        expect(keyIntent(press(`h`, { meta: true }), true)).toEqual({ kind: `device` });
    });

    // `i` sits in both worlds: Ctrl+I italicizes on the page, Ctrl+Shift+I opens the developer tools.
    test("the developer tools and the page's source open by Chromium's own chords", () => {
        expect(keyIntent(press(`F12`), false)).toEqual({ kind: `command`, command: `devtools` });
        for (const letter of [`I`, `J`, `C`]) {
            expect(keyIntent(press(letter, { ctrl: true, shift: true }), false)).toEqual({ kind: `command`, command: `devtools` });
        }
        expect(keyIntent(press(`i`, { ctrl: true }), false)).toEqual({ kind: `key`, frame: { type: `key`, key: `i`, ctrl: true } });
        // Option makes ⌥I a dead key, so the physical key is what says which tool.
        expect(keyIntent(press(`Dead`, { meta: true, alt: true }, `KeyI`), true)).toEqual({ kind: `command`, command: `devtools` });
        expect(keyIntent(press(`ü`, { meta: true, alt: true }, `KeyU`), true)).toEqual({ kind: `command`, command: `viewSource` });
        // Ctrl+U underlines in a rich-text editor, so on a PC it stays the page's.
        expect(keyIntent(press(`u`, { ctrl: true }), false)).toEqual({ kind: `key`, frame: { type: `key`, key: `u`, ctrl: true } });
    });

    // On a Cyrillic layout Ctrl+T reports the letter it types there; Chromium reads its shortcuts off the physical key.
    test("a chord on a non-Latin layout is read off the physical key", () => {
        expect(keyIntent(press(`е`, { ctrl: true }, `KeyT`), false)).toEqual({ kind: `command`, command: `newTab` });
        expect(keyIntent(press(`ф`, { ctrl: true }, `KeyA`), false)).toEqual({ kind: `key`, frame: { type: `key`, key: `a`, ctrl: true } });
    });
});
