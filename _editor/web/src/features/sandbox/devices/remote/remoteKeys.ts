import type { KeyMessage } from "../../../../models/browsers/inputWire";

// A KEYBOARD ON SOMEONE ELSE'S COMPUTER. Every key goes as the physical key it is (`code`) with the name this layout
// gives it (`key`), pressed and released as the hand does (`down`, `up`), so the far computer's own layout, dead keys,
// shortcuts and held modifiers all behave as if this keyboard were plugged into it; nothing is read as a command here.
// What only the person's own browser can supply stays with it: an input method's composition and a phone's on-screen
// keyboard (no physical key, `code` empty) arrive as text through the stage's hidden field (inputSink.ts), and a paste
// reads this computer's clipboard first, which the far end receives before the V that pastes it. Every key still held
// is let go when the picture loses the keyboard, so nothing stays pressed over there.
//
// On a Mac, Command goes as Control (a Mac's ⌘C is the far end's Ctrl+C) and Control as Control; the far end's own
// Windows key is in the send-keys menu.

// What may be sent: a key message in this vocabulary, or "let go of everything".
export type RemoteKeyMessage = KeyMessage | { readonly type: `releaseAll` };

export interface RemoteKeysOptions {
    readonly send: (message: RemoteKeyMessage) => void;
    readonly isMac: boolean;
    // How long a paste chord waits for the paste event that carries the clipboard before it goes without it.
    readonly pasteWaitMs?: number;
    readonly later?: (run: () => void, ms: number) => () => void;
}

export interface RemoteKeys {
    readonly keydown: (event: KeyboardEvent) => void;
    readonly keyup: (event: KeyboardEvent) => void;
    // The paste the last V was waiting on arrived (and sent its clipboard and chord itself).
    readonly pasted: () => void;
    readonly releaseAll: () => void;
    // A chord from the send-keys menu: each key down in order, then up in reverse.
    readonly press: (chord: readonly RemoteKey[]) => void;
}

export interface RemoteKey {
    readonly key: string;
    readonly code: string;
}

export const PASTE_WAIT_MS = 200;

// Named chords a browser cannot send itself, or that this computer would act on instead (outside full screen).
export const SEND_KEYS = {
    ctrlAltDel: [
        { key: `Control`, code: `ControlLeft` },
        { key: `Alt`, code: `AltLeft` },
        { key: `Delete`, code: `Delete` },
    ],
    win: [{ key: `Meta`, code: `MetaLeft` }],
    altTab: [
        { key: `Alt`, code: `AltLeft` },
        { key: `Tab`, code: `Tab` },
    ],
    printScreen: [{ key: `PrintScreen`, code: `PrintScreen` }],
    taskManager: [
        { key: `Control`, code: `ControlLeft` },
        { key: `Shift`, code: `ShiftLeft` },
        { key: `Escape`, code: `Escape` },
    ],
} as const satisfies Record<string, readonly RemoteKey[]>;
export type SendKeysChord = keyof typeof SEND_KEYS;

// What the person's own browser types itself: a composition under way, a key an input method is holding, or one with
// no physical key behind it (a phone's on-screen keyboard).
const browserTyped = (event: KeyboardEvent): boolean =>
    event.isComposing || event.key === `Process` || event.key === `Unidentified` || event.code === ``;

// On a Mac, ⌘ goes as the far end's Control.
const physical = (event: KeyboardEvent, isMac: boolean): RemoteKey => {
    if (isMac && (event.code === `MetaLeft` || event.code === `MetaRight`)) {
        return { key: `Control`, code: event.code === `MetaLeft` ? `ControlLeft` : `ControlRight` };
    }
    return { key: event.key, code: event.code };
};

// The chord that pastes: V with this platform's primary modifier and nothing else.
const pasteChord = (event: KeyboardEvent, isMac: boolean): boolean =>
    event.code === `KeyV` && (isMac ? event.metaKey : event.ctrlKey) && !event.altKey && !event.shiftKey;

const timeout = (run: () => void, ms: number): (() => void) => {
    const timer = setTimeout(run, ms);
    return () => clearTimeout(timer);
};

export const remoteKeys = (options: RemoteKeysOptions): RemoteKeys => {
    const later = options.later ?? timeout;
    const held = new Map<string, RemoteKey>();
    let pasteWait: (() => void) | undefined;

    const down = (key: RemoteKey): void => {
        held.set(key.code, key);
        options.send({ type: `key`, key: key.key, code: key.code, action: `down` });
    };
    const up = (key: RemoteKey): void => {
        held.delete(key.code);
        options.send({ type: `key`, key: key.key, code: key.code, action: `up` });
    };

    return {
        keydown: (event) => {
            if (browserTyped(event)) {
                return;
            }
            // Left to the browser, so its paste event reads this computer's clipboard; the V follows it (`pasted`), or
            // goes alone if no paste comes (nothing on the clipboard this page may read).
            if (pasteChord(event, options.isMac)) {
                pasteWait?.();
                const key = physical(event, options.isMac);
                pasteWait = later(() => {
                    pasteWait = undefined;
                    down(key);
                    up(key);
                }, options.pasteWaitMs ?? PASTE_WAIT_MS);
                return;
            }
            event.preventDefault();
            event.stopPropagation();
            down(physical(event, options.isMac));
        },
        keyup: (event) => {
            const key = physical(event, options.isMac);
            if (held.has(key.code)) {
                event.preventDefault();
                up(key);
            }
        },
        pasted: () => {
            pasteWait?.();
            pasteWait = undefined;
        },
        releaseAll: () => {
            pasteWait?.();
            pasteWait = undefined;
            held.clear();
            options.send({ type: `releaseAll` });
        },
        press: (chord) => {
            chord.forEach(down);
            chord.toReversed().forEach(up);
        },
    };
};
