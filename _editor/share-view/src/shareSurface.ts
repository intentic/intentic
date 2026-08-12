import type { ChatSurface } from "@intentic-app/web/chat/chatSurface";

/* WHAT A TOOL CARD CAN REACH ON A PUBLISHED PAGE: its own pictures, and nothing else.
 *
 * Every other capability the app's surface offers — opening a file, attaching to the shell a command ran in,
 * a delegation's transcript — is a door into a workspace that is not here and must never appear to be. Left
 * undefined, the card draws each of those as what it always was: the record that a file was read, that a
 * command ran, that work was handed off.
 *
 * Pictures ARE here because they are part of what was said. The daemon copied every one the conversation shows
 * into the share's own folder and rewrote the paths in the payload to point at those copies, so a path in a
 * card is already relative to this page — which is why this is identity rather than a lookup, and why nothing
 * on this page ever addresses a workspace file. Anything that somehow still looks absolute is refused rather
 * than requested: a page that reaches outside its own directory is exactly what this design rules out. */
export const shareSurface: ChatSurface = {
    imageUrl: (path) => (path.startsWith("/") || path.includes("://") || path.includes("..") ? undefined : path),
};
