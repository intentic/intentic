/* Which window's clipboard a copy goes through.
 *
 * Chrome's async clipboard is gated on the CALLING document's focus: `navigator.clipboard.writeText` from a
 * document that is not focused rejects with NotAllowedError ("Document is not focused"), and every call site
 * swallows that rejection, so the press does precisely nothing, no clipboard write, no "Copied", no error on
 * screen. That is exactly what a copy inside a floating panel used to do, when the panel's DOM was in one window
 * and its JS in another; the panels are their own windows now, and the app still draws into iframes (the
 * preview, the extension host).
 *
 * So the element the gesture happened on is asked rather than the module: its ownerDocument IS the focused
 * document, whatever surface it belongs to, and there is a fallback to this realm's clipboard when there is no
 * element to ask (or a detached one). */
export const clipboardOf = (element: Element | null | undefined): Clipboard =>
    element?.ownerDocument.defaultView?.navigator.clipboard ?? navigator.clipboard;
