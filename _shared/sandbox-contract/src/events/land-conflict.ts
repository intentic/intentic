import { withoutResumeNote } from "./resume.js";

// The turn the app sends a conversation whose land refused, asking it to rebase and resolve, recognised by its opening.
// Composed by the editor, but lives here because the fold must recognise it as well: that turn's own rebase notice
// would otherwise tell the reader the thing the turn was sent to fix.

// Anchored on by the chat and the fold, so it must stay unique and stable across releases.
export const LAND_CONFLICT_OPENING =
    "Landing your work hit a merge conflict, none of it reached the user's workspace; it is all still on your branch. Rebase onto the main line and resolve the conflicts yourself. In each repo below (`root` is your working directory, any other name that subdirectory of it):";

// Whether a stored prompt is one. A turn the daemon re-ran carries the same prompt after its resume note.
export const isLandConflict = (prompt: string): boolean => withoutResumeNote(prompt.trim()).startsWith(LAND_CONFLICT_OPENING);
