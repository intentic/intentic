import { isApplePlatform } from "@intentic/ui/keys";
import type { ClipboardContent } from "@intentic/sandbox-contract/browser-wire";
import type { InputMessage, KeyMessage } from "./inputWire";
import { keyFrames, keyIntent, type BrowserCommand, type KeyFrame } from "./keyIntent";

// THE KEYBOARD OF A LIVE BROWSER: a hidden <textarea> that holds focus while the picture does, so the person's own
// browser treats typing there as typing into a field. That is what brings everything a keydown alone never carried:
// an IME's candidates (Chinese, Japanese, Korean), the Windows emoji panel, dictation, dead keys (´ then e is é), and a
// phone's on-screen keyboard, which opens only for a field. A keydown is read first (keyIntent.ts): a chord, a control
// key or a plain character is sent from there and kept out of the field; anything an input method owns is left to it,
// and what it commits arrives here as `beforeinput` or `compositionend` and goes as committed text. A paste reads the
// person's own clipboard (text, HTML and an image), which the far end receives before the Ctrl+V that pastes it.
//
// The sink speaks the media vocabulary (inputWire.ts); the socket's adapter decides how each message travels.

export interface InputSinkOptions {
    // Where the messages go; the caller decides whether anything is sent at all (only while the person drives).
    readonly send: (message: InputMessage) => void;
    readonly isMac?: boolean | undefined;
    // A pasted image as a PNG in base64, or undefined when it cannot be read; absent drops images from a paste.
    readonly pngOf?: (image: File) => Promise<string | undefined>;
}

// What a paste carries, as a ClipboardEvent's clipboardData has it; only these fields are read.
export interface PastedData {
    readonly getData: (format: string) => string;
    readonly items?: ArrayLike<Pick<DataTransferItem, `kind` | `type` | `getAsFile`>>;
}
export interface PasteEvent {
    readonly clipboardData: PastedData | null;
    readonly preventDefault: () => void;
}

export interface InputSink {
    // `onCommand` takes the browser's own shortcuts (keyIntent's `command`); undefined leaves them unanswered.
    readonly keydown: (event: KeyboardEvent, onCommand?: (command: BrowserCommand) => void) => void;
    readonly beforeinput: (event: InputEvent) => void;
    // Empties the field once an edit has landed in it, unless an input method is still composing there. Any `input`
    // event: the DOM types it as a plain Event.
    readonly input: (event: Event) => void;
    readonly compositionend: (event: CompositionEvent) => void;
    readonly paste: (event: PasteEvent) => void;
}

// A field's edits that are keystrokes on the page: what an on-screen keyboard sends for its Backspace and Enter (an
// Android keyboard's keydown names none of them) and what a word-delete gesture asks.
const EDIT_KEYS: ReadonlyMap<string, Omit<KeyMessage, `type`>> = new Map([
    [`deleteContentBackward`, { key: `Backspace`, code: `Backspace` }],
    [`deleteContentForward`, { key: `Delete`, code: `Delete` }],
    [`deleteWordBackward`, { key: `Backspace`, code: `Backspace`, ctrl: true }],
    [`deleteWordForward`, { key: `Delete`, code: `Delete`, ctrl: true }],
    [`insertLineBreak`, { key: `Enter`, code: `Enter` }],
    [`insertParagraph`, { key: `Enter`, code: `Enter` }],
]);

// The text a field edit inserts, for the kinds that insert text: typing (an emoji panel, dictation, a mobile keyboard's
// letter) and an autocorrection's replacement word.
const INSERTS = new Set([`insertText`, `insertReplacementText`]);

const emptied = (target: EventTarget | null): void => {
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
        target.value = ``;
    }
};

// One keystroke as the media vocabulary says it, with the physical key where the name is the event's own (a Mac's ⌘← is
// sent as Home, which no physical key of this event is).
const keyMessage = (frame: Pick<KeyFrame, `key` | `ctrl` | `shift`>, event: KeyboardEvent): KeyMessage => {
    const message: KeyMessage = { type: `key`, key: frame.key, action: `press` };
    if (frame.key === event.key && event.code !== ``) {
        message.code = event.code;
    }
    if (frame.ctrl === true) {
        message.ctrl = true;
    }
    if (frame.shift === true) {
        message.shift = true;
    }
    return message;
};

// The first image a paste carries, if any.
const pastedImage = (data: PastedData): File | undefined => {
    for (const item of Array.from(data.items ?? [])) {
        if (item.kind === `file` && item.type.startsWith(`image/`)) {
            return item.getAsFile() ?? undefined;
        }
    }
    return undefined;
};

const PASTE_CHORD: KeyMessage = { type: `key`, key: `v`, code: `KeyV`, ctrl: true, action: `press` };

// Sends in order, and holds everything behind a paste whose image is still being read, so what is typed meanwhile
// lands after the paste, in the order it was typed. Nothing waits while no paste does.
const orderedSend = (deliver: (message: InputMessage) => void) => {
    let waiting = 0;
    let chain: Promise<void> = Promise.resolve();
    return {
        send: (message: InputMessage): void => {
            if (waiting === 0) {
                deliver(message);
            } else {
                chain = chain.then(() => deliver(message));
            }
        },
        // What `ready` settles to, sent in this message's place in the order.
        after: (ready: Promise<readonly InputMessage[]>): void => {
            waiting += 1;
            chain = chain
                .then(() => ready)
                .then((messages) => messages.forEach(deliver))
                .finally(() => {
                    waiting -= 1;
                });
        },
    };
};

// A paste: the person's own clipboard, which the far end receives before the chord that pastes it.
const pasteHandler =
    (options: InputSinkOptions, ordered: ReturnType<typeof orderedSend>) =>
    (event: PasteEvent): void => {
        const data = event.clipboardData;
        if (data === null) {
            return;
        }
        const text = data.getData(`text/plain`);
        const html = data.getData(`text/html`);
        const image = options.pngOf === undefined ? undefined : pastedImage(data);
        if (text === `` && html === `` && image === undefined) {
            return;
        }
        event.preventDefault();
        const content: ClipboardContent = {};
        if (text !== ``) {
            content.text = text;
        }
        if (html !== ``) {
            content.html = html;
        }
        if (image === undefined || options.pngOf === undefined) {
            ordered.send({ type: `clipboard`, content });
            ordered.send(PASTE_CHORD);
            return;
        }
        // allow(silent-catch): an image that cannot be read pastes what else the clipboard held.
        const png = options.pngOf(image).catch(() => undefined);
        ordered.after(
            png.then((encoded): readonly InputMessage[] => [
                { type: `clipboard`, content: encoded === undefined ? content : { ...content, png: encoded } },
                PASTE_CHORD,
            ]),
        );
    };

// What a field edit means on the page: a keystroke for a delete or a line break, text for an insert, nothing for the
// rest.
const editMessage = (event: InputEvent): InputMessage | undefined => {
    const edit = EDIT_KEYS.get(event.inputType);
    if (edit !== undefined) {
        return { type: `key`, ...edit, action: `press` };
    }
    return INSERTS.has(event.inputType) && event.data !== null && event.data !== `` ? { type: `text`, text: event.data } : undefined;
};

export const inputSink = (options: InputSinkOptions): InputSink => {
    const isMac = options.isMac ?? isApplePlatform();
    const ordered = orderedSend(options.send);
    const { send } = ordered;

    const keydown = (event: KeyboardEvent, onCommand?: (command: BrowserCommand) => void): void => {
        const intent = keyIntent(event, isMac);
        // The host's, or the input method's: no default prevented, so the field composes, pastes, or lets the host have
        // its shortcut.
        if (intent.kind === `device`) {
            return;
        }
        event.preventDefault();
        // The keystroke is the page's now; the editor's own shortcuts on the window must not act on it as well.
        event.stopPropagation();
        if (intent.kind === `command`) {
            onCommand?.(intent.command);
        } else if (intent.kind === `text`) {
            send(keyMessage({ key: intent.text }, event));
        } else if (intent.kind === `key`) {
            keyFrames(intent).forEach((frame) => send(keyMessage(frame, event)));
        } else {
            send(keyMessage(intent.frame, event));
        }
    };

    return {
        keydown,
        beforeinput: (event) => {
            // A composition's text is sent once, whole, when it ends; what it shows meanwhile is the input method's draft.
            if (event.isComposing) {
                return;
            }
            // The paste event carries the clipboard itself, and a drop has nowhere to go on the page.
            if (event.inputType === `insertFromPaste` || event.inputType === `insertFromDrop`) {
                event.preventDefault();
                return;
            }
            const message = editMessage(event);
            if (message !== undefined) {
                event.preventDefault();
                send(message);
            }
        },
        input: (event) => {
            if (!(event instanceof InputEvent && event.isComposing)) {
                emptied(event.target);
            }
        },
        compositionend: (event) => {
            if (event.data !== ``) {
                send({ type: `text`, text: event.data });
            }
            emptied(event.target);
        },
        paste: pasteHandler(options, ordered),
    };
};

/** A pasted image as a PNG in base64: a PNG as it is, anything else drawn once and encoded. */
export const pngOfImage = async (image: File): Promise<string | undefined> => {
    const bytes =
        image.type === `image/png`
            ? new Uint8Array(await image.arrayBuffer())
            : await (async () => {
                  const bitmap = await createImageBitmap(image);
                  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
                  canvas.getContext(`2d`)?.drawImage(bitmap, 0, 0);
                  bitmap.close();
                  return new Uint8Array(await (await canvas.convertToBlob({ type: `image/png` })).arrayBuffer());
              })();
    let binary = ``;
    // In slices: one call with every byte of a large image as an argument overflows the stack.
    for (let at = 0; at < bytes.length; at += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
    }
    return btoa(binary);
};
