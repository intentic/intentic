// The follow-up the daemon sends a conversation whose land turned the main tree's own check red, recognised by its opening.

// Anchored on by the chat, so it must stay unique and stable across releases.
export const LAND_BREAKAGE_OPENING =
    "What this conversation landed turned the main tree's own check red after it arrived. Each failure below appeared with that land and was not failing before it. Fix them on this branch and check the fix as you would any change; it lands like any other turn.";

// The prompt a breakage actually sends: its opening, then the failures, each already worded for the model.
export const landBreakagePrompt = (parts: readonly string[]): string => [LAND_BREAKAGE_OPENING, ...parts].join("\n\n");

// Whether a stored prompt is one.
export const isLandBreakage = (prompt: string): boolean => prompt.startsWith(LAND_BREAKAGE_OPENING);

// The opening of a FRESH conversation the daemon starts on a red main-line check that the conversation that landed the
// work could not take: nobody could be named, several could, or the one named had gone cold or run out of room.
// Anchored on by the chat like the follow-up above, so it must stay unique and stable across releases.
export const LAND_FIX_OPENING =
    "The main tree's own check went red after work landed, and no conversation still holding that work could take it, so this one was started to fix it. The failures, the lands they arrived with and where to read those conversations are below. Fix them in this isolated worktree and check the fix as you would any change; your work lands like any other turn.";

// The prompt a fresh fix-up is started with: its opening, then the evidence, each part already worded for the model.
export const landFixPrompt = (parts: readonly string[]): string => [LAND_FIX_OPENING, ...parts].join("\n\n");

// Whether a stored prompt is one.
export const isLandFix = (prompt: string): boolean => prompt.startsWith(LAND_FIX_OPENING);
