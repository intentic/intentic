import { getCurrentScope, onScopeDispose, ref, type Ref } from "vue";

// Clipboard writes must go through the focused document: Chrome's async clipboard API rejects `writeText` from an
// unfocused document with NotAllowedError, silently. Uses the triggering element's `ownerDocument`'s window; falls
// back to this realm's clipboard if there's no element to ask. Every clipboard call in the app goes through here
// (`clipboard-tiers` in _tools/checks refuses a bare `navigator.clipboard`).
export const clipboardOf = (element: Element | null | undefined): Clipboard =>
    element?.ownerDocument.defaultView?.navigator.clipboard ?? navigator.clipboard;

// Writes `text` through `from`'s window and says whether it landed. Never rejects: outside a secure context there is
// no clipboard at all, and a browser may refuse the write, and neither is the caller's failure to handle.
export const writeClipboard = async (text: string, from?: Element | null): Promise<boolean> => {
    try {
        await clipboardOf(from).writeText(text);
        return true;
    } catch {
        // allow(silent-catch): refused or unavailable is the `false` this answers; the text is still on screen to select.
        return false;
    }
};

// What the clipboard holds as text, read through `from`'s window, or undefined where it cannot be read (no clipboard,
// permission refused). Never rejects, for the same reasons.
export const readClipboard = async (from?: Element | null): Promise<string | undefined> => {
    try {
        return await clipboardOf(from).readText();
    } catch {
        // allow(silent-catch): refused or unavailable is the `undefined` this answers; a manual paste still works.
        return undefined;
    }
};

// How long a "Copied" acknowledgement stays before the control reads as itself again.
export const COPIED_MS = 1500;

export interface Copied {
    // True from a write that landed until `holdMs` later (or until `reset`, for a held one).
    readonly copied: Readonly<Ref<boolean>>;
    readonly copy: (text: string, from?: Element | null) => Promise<boolean>;
    readonly reset: () => void;
}

// A copy action with its acknowledgement. `holdMs: Infinity` keeps it up until `reset`, for a note that says the
// copy happened rather than flashing that it did.
export const useCopied = (holdMs: number = COPIED_MS): Copied => {
    const copied = ref(false);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const reset = (): void => {
        clearTimeout(timer);
        timer = undefined;
        copied.value = false;
    };
    const copy = async (text: string, from?: Element | null): Promise<boolean> => {
        const landed = await writeClipboard(text, from);
        if (landed) {
            clearTimeout(timer);
            copied.value = true;
            timer = Number.isFinite(holdMs) ? setTimeout(() => (copied.value = false), holdMs) : undefined;
        }
        return landed;
    };
    if (getCurrentScope() !== undefined) {
        onScopeDispose(() => clearTimeout(timer));
    }
    return { copied, copy, reset };
};
