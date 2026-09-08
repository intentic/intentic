// Clipboard writes must go through the focused document: Chrome's async clipboard API rejects `writeText` from an
// unfocused document with NotAllowedError, silently. Uses the triggering element's `ownerDocument`'s window; falls
// back to this realm's clipboard if there's no element to ask.
export const clipboardOf = (element: Element | null | undefined): Clipboard =>
    element?.ownerDocument.defaultView?.navigator.clipboard ?? navigator.clipboard;
