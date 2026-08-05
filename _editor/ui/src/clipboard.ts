/* Which window's clipboard a copy goes through.
 *
 * A POPPED-OUT panel (see usePopout) is DOM teleported into a real second window while the JS keeps running in
 * the opener's realm. So the module-global `navigator` out there belongs to the ORIGINAL document — the one the
 * user is not looking at and, crucially, not focused on. Chrome's async clipboard is gated on the calling
 * document's focus, so `navigator.clipboard.writeText` from a pop-out rejects with NotAllowedError ("Document
 * is not focused"); every call site swallows that rejection, which is why pressing Copy in a popped-out chat
 * did precisely nothing — no clipboard write, no "Copied", no error on screen.
 *
 * The element the gesture happened on knows better than the module does: its ownerDocument IS the focused
 * window's document. Reaching the clipboard through it makes the same code work docked and popped out, and it
 * falls back to this realm's own clipboard when there is no element to ask (or a detached one). */
export const clipboardOf = (element: Element | null | undefined): Clipboard =>
    element?.ownerDocument.defaultView?.navigator.clipboard ?? navigator.clipboard;
