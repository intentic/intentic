// The follow-ups the daemon USED to send when the check it ran after every land went red: back to the conversation
// that landed the work, or to a fresh conversation started on it. Nothing sends either any more: nothing checks work
// after it lands, CI checks what the owner pushes (schemas/ci.ts). They stay on the wire because records already hold
// them, and the chat has to go on recognising them: a prompt nobody typed must not reach a reader as their own words.

// Anchored on by the chat, so it must stay unique and stable across releases.
export const LAND_BREAKAGE_OPENING =
    "What this conversation landed turned the main tree's own check red after it arrived. Each failure below appeared with that land and was not failing before it. Fix them on this branch and check the fix as you would any change; it lands like any other turn.";

// Whether a stored prompt is one.
export const isLandBreakage = (prompt: string): boolean => prompt.startsWith(LAND_BREAKAGE_OPENING);

// Anchored on by the chat like the follow-up above, so it must stay unique and stable across releases.
export const LAND_FIX_OPENING =
    "The main tree's own check went red after work landed, and no conversation still holding that work could take it, so this one was started to fix it. The failures, the lands they arrived with and where to read those conversations are below. Fix them in this isolated worktree and check the fix as you would any change; your work lands like any other turn.";

// Whether a stored prompt is one.
export const isLandFix = (prompt: string): boolean => prompt.startsWith(LAND_FIX_OPENING);
