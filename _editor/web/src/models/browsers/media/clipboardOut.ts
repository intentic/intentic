import type { ClipboardContent } from "@intentic/sandbox-contract/browser-wire";
import { clipboardOf } from "@intentic/ui/clipboard";

// A COPY MADE IN THE SANDBOX'S BROWSER, ONTO THE PERSON'S OWN CLIPBOARD. castd sends `clipboard` whenever the window's
// CLIPBOARD changes (a Ctrl+C on the page, a "Copy" in its menu, or the agent's own). It is written only while the stage
// has focus (the picture's box, or its input sink inside it): the document alone is not enough, since the person may be
// typing in another pane while the agent copies. One that cannot be written then is held, and written on the person's
// next press in the stage, which is a gesture; but only for HELD_MS, and never once the person has copied or cut
// something themselves in that document, since it would overwrite what they copied since. Only the latest copy is held.
// Written through the stage's own window (a popped-out one has its own clipboard and its own focus).

export interface ClipboardSeams {
    // Whether the stage has focus now (stageHasFocus below): a copy is written only there.
    readonly focused: () => boolean;
    // Writes every form the content has; rejects when the browser refuses.
    readonly write: (content: ClipboardContent) => Promise<void>;
    // Calls `onCopy` when the person copies or cuts in the stage's document; listened to only while a copy is held.
    readonly listen: (onCopy: () => void) => () => void;
    readonly now?: () => number;
}

export interface ClipboardOut {
    // castd's `clipboard`: written now if it can be, else held.
    readonly remote: (content: ClipboardContent) => void;
    // A user gesture in the stage: the held copy, if any and still fresh, is written now.
    readonly gesture: () => void;
    // What waits for a gesture, for a test and for a hint on screen.
    readonly held: () => ClipboardContent | undefined;
    readonly forget: () => void;
}

// How long a copy waits for the person's next press in the stage; older, it is likely not what they want pasted.
const HELD_MS = 5000;

const empty = (content: ClipboardContent): boolean =>
    (content.text === undefined || content.text === ``) &&
    (content.html === undefined || content.html === ``) &&
    (content.png === undefined || content.png === ``);

/** Whether the stage `picture` sits in (its nearest focusable ancestor) or anything inside it has the focus. */
export const stageHasFocus = (picture: Element | undefined): boolean => {
    const stage = picture?.closest(`[tabindex]:not([tabindex="-1"])`);
    const doc = picture?.ownerDocument;
    return stage !== null && stage !== undefined && doc !== undefined && doc.hasFocus() && stage.contains(doc.activeElement);
};

export const clipboardOut = (seams: ClipboardSeams): ClipboardOut => {
    const now = seams.now ?? Date.now;
    let held: { readonly content: ClipboardContent; readonly at: number } | undefined;
    let unlisten: (() => void) | undefined;
    // Counts copies, so a refused write of an older one never holds it over a newer one that came meanwhile.
    let latest = 0;
    const drop = (): void => {
        held = undefined;
        unlisten?.();
        unlisten = undefined;
    };
    const hold = (content: ClipboardContent, at: number): void => {
        held = { content, at };
        unlisten ??= seams.listen(drop);
    };
    const write = (content: ClipboardContent, at: number): void => {
        latest += 1;
        const mine = latest;
        drop();
        seams.write(content).catch(() => {
            if (mine === latest) {
                hold(content, at);
            }
        });
    };
    // The held copy while it is fresh; one past HELD_MS is let go of.
    const waiting = (): typeof held => {
        if (held !== undefined && now() - held.at > HELD_MS) {
            drop();
        }
        return held;
    };
    return {
        remote: (content) => {
            if (empty(content)) {
                return;
            }
            if (seams.focused()) {
                write(content, now());
                return;
            }
            latest += 1;
            hold(content, now());
        },
        gesture: () => {
            const copy = waiting();
            if (copy !== undefined) {
                write(copy.content, copy.at);
            }
        },
        held: () => waiting()?.content,
        forget: () => {
            latest += 1;
            drop();
        },
    };
};

/** Calls `onCopy` at the person's own copy or cut anywhere in `doc`; returns the stop. */
export const copiesIn = (doc: Document, onCopy: () => void): (() => void) => {
    doc.addEventListener(`copy`, onCopy, true);
    doc.addEventListener(`cut`, onCopy, true);
    return () => {
        doc.removeEventListener(`copy`, onCopy, true);
        doc.removeEventListener(`cut`, onCopy, true);
    };
};

/** The clipboard of the stage `picture()` sits in: its focus, its window's clipboard, its document's copies. */
export const stageClipboard = (picture: () => Element | undefined): ClipboardOut =>
    clipboardOut({
        focused: () => stageHasFocus(picture()),
        write: (content) => writeClipboard(content, picture()),
        listen: (onCopy) => copiesIn(picture()?.ownerDocument ?? document, onCopy),
    });

const pngBlob = (base64: string): Blob => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let at = 0; at < binary.length; at += 1) {
        bytes[at] = binary.charCodeAt(at);
    }
    return new Blob([bytes], { type: `image/png` });
};

/**
 * The clipboard of `from`'s window, every form at once where it takes a ClipboardItem, the text alone where it does not.
 * Rejects when the browser refuses, which the caller holds the copy for.
 */
const writeClipboard = async (content: ClipboardContent, from?: Element): Promise<void> => {
    // Absent outside a secure context, whatever the types say.
    const clipboard: Clipboard | undefined = clipboardOf(from);
    const view = from?.ownerDocument.defaultView ?? window;
    if (clipboard === undefined) {
        throw new Error(`No clipboard in this browser.`);
    }
    if (!(`ClipboardItem` in view)) {
        await clipboard.writeText(content.text ?? ``);
        return;
    }
    const parts: Record<string, Blob> = {};
    if (content.text !== undefined && content.text !== ``) {
        parts[`text/plain`] = new Blob([content.text], { type: `text/plain` });
    }
    if (content.html !== undefined && content.html !== ``) {
        parts[`text/html`] = new Blob([content.html], { type: `text/html` });
    }
    if (content.png !== undefined && content.png !== ``) {
        parts[`image/png`] = pngBlob(content.png);
    }
    await clipboard.write([new view.ClipboardItem(parts)]);
};
