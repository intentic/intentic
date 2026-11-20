import type { BrowserMediaClientMessage, BrowserViewClientMessage } from "@intentic/sandbox-contract/browser-wire";

// THE PERSON'S INPUT ON A LIVE BROWSER, WHICHEVER SOCKET CARRIES IT. The input layer (inputSink.ts, wheelSteps.ts,
// touchGestures.ts) speaks browser-wire's media vocabulary, the one castd answers on /system/browser-media: pointer,
// precise scroll, keys with an action, committed text, the clipboard, and letting go of everything. One small adapter
// per socket turns that into what the socket takes: `mediaInput` passes it through, and `viewInput` folds it into
// today's /system/browser-view messages, which the Node daemon replays over CDP and xdotool.

export type InputMessage = Extract<BrowserMediaClientMessage, { type: `mouse` | `scroll` | `key` | `text` | `clipboard` | `releaseAll` }>;
export type KeyMessage = Extract<InputMessage, { type: `key` }>;
export type MouseMessage = Extract<InputMessage, { type: `mouse` }>;

// Where the input layer sends what it made of a gesture or a keystroke.
export interface InputPort {
    readonly send: (message: InputMessage) => void;
}

/** The media socket's own vocabulary: nothing to translate. */
export const mediaInput = (send: (message: BrowserMediaClientMessage) => void): InputPort => ({ send });

// DOM buttons as bits of `buttons`: left 1, right 2, middle 4, back 8, forward 16.
const BUTTON_BITS: readonly number[] = [1, 4, 2, 8, 16];
const bitOf = (button: number | undefined): number => BUTTON_BITS[button ?? 0] ?? 1;
const buttonOf = (bit: number): number => BUTTON_BITS.indexOf(bit);

type Modifier = `ctrl` | `shift` | `alt`;
type Flags = { [name in Modifier]?: true };

// The modifier keys whose down and up the view socket folds into flags, by DOM key name.
const MODIFIER_FLAGS: ReadonlyMap<string, Modifier> = new Map([
    [`Control`, `ctrl`],
    [`Shift`, `shift`],
    [`Alt`, `alt`],
]);

// A key the view socket inserts as text rather than pressing: one printable character with no chord, as Input.insertText
// types it exactly whatever the remote layout. Space stays a key, so a focused button or checkbox answers it.
const insertedText = (message: KeyMessage): string | undefined =>
    message.ctrl !== true && message.alt !== true && [...message.key].length === 1 && message.key !== ` ` ? message.key : undefined;

export interface ViewInputOptions {
    // Whether keys and text go to the X display rather than the page: Chromium's find bar has the keyboard.
    readonly raw?: () => boolean;
    // A copy or cut chord, which this socket answers by reading the page's selection first (selectionCopy.ts).
    readonly copy?: (chord: { readonly type: `key`; readonly key: string; readonly ctrl?: boolean; readonly shift?: boolean }) => void;
}

/**
 * The browser view socket, which has no scroll, no key action, no clipboard and no releaseAll of its own: a scroll is a
 * wheel event with exact pixel deltas, a held modifier is a flag on what follows, pasted text is inserted (the chord
 * after it would paste the sandbox's own clipboard), and letting go releases the buttons this adapter saw pressed.
 */
export const viewInput = (send: (message: BrowserViewClientMessage) => void, options: ViewInputOptions = {}): InputPort => {
    // What the remote side holds because of this viewer: buttons pressed and not released, modifiers put down by a key.
    let buttons = 0;
    let at = { x: 0, y: 0 };
    const held = { ctrl: false, shift: false, alt: false };
    const raw = (): { raw?: true } => (options.raw?.() === true ? { raw: true } : {});
    // A message's own modifiers with the ones a key put down; set only when true, so the common case stays small.
    const flags = (own: { readonly [name in Modifier]?: boolean }): Flags => {
        const out: Flags = {};
        for (const name of [`ctrl`, `shift`, `alt`] as const) {
            if (own[name] === true || held[name]) {
                out[name] = true;
            }
        }
        return out;
    };

    const mouse = (message: MouseMessage): void => {
        at = { x: message.x, y: message.y };
        if (message.action === `down`) {
            buttons = message.buttons ?? buttons | bitOf(message.button);
        } else if (message.action === `up`) {
            buttons = message.buttons ?? buttons & ~bitOf(message.button);
        }
        send({ ...message, ...flags(message) });
    };

    const key = (message: KeyMessage): void => {
        const modifier = MODIFIER_FLAGS.get(message.key);
        if (modifier !== undefined) {
            // Down and up are what a held modifier is; a press of one alone does nothing on a page.
            if (message.action === `down` || message.action === `up`) {
                held[modifier] = message.action === `down`;
            }
            return;
        }
        // This socket replays whole keystrokes only.
        if (message.action === `up`) {
            return;
        }
        const chord = { type: `key` as const, key: message.key, ...flags(message) };
        const letter = message.key.toLowerCase();
        if (chord.ctrl === true && chord.alt !== true && chord.shift !== true && letter === `v`) {
            // The paste itself went as text with the clipboard message before it.
            return;
        }
        if (chord.ctrl === true && chord.alt !== true && (letter === `c` || letter === `x`) && options.copy !== undefined) {
            options.copy({ ...chord, key: letter });
            return;
        }
        const text = held.ctrl || held.alt ? undefined : insertedText(message);
        send(text === undefined ? { ...chord, ...raw() } : { type: `text`, text, ...raw() });
    };

    return {
        send: (message) => {
            switch (message.type) {
                case `mouse`:
                    mouse(message);
                    return;
                case `scroll`:
                    at = { x: message.x, y: message.y };
                    send({
                        type: `mouse`,
                        action: `wheel`,
                        x: message.x,
                        y: message.y,
                        buttons,
                        deltaX: message.dx,
                        deltaY: message.dy,
                        ...flags({}),
                    });
                    return;
                case `key`:
                    key(message);
                    return;
                case `text`:
                    send({ type: `text`, text: message.text, ...raw() });
                    return;
                case `clipboard`:
                    if (message.content.text !== undefined && message.content.text !== ``) {
                        send({ type: `text`, text: message.content.text, ...raw() });
                    }
                    return;
                case `releaseAll`: {
                    // Released one at a time, highest bit first, each up naming what is still held after it.
                    for (const bit of [...BUTTON_BITS].sort((left, right) => right - left)) {
                        if ((buttons & bit) !== 0) {
                            buttons &= ~bit;
                            send({ type: `mouse`, action: `up`, x: at.x, y: at.y, button: buttonOf(bit), buttons });
                        }
                    }
                    held.ctrl = held.shift = held.alt = false;
                    return;
                }
            }
        },
    };
};
