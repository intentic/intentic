// The follow-up the daemon sends a conversation whose land turned the main tree's own check red, recognised by its opening.

// Anchored on by the chat, so it must stay unique and stable across releases.
export const LAND_BREAKAGE_OPENING =
    "What this conversation landed turned the main tree's own check red after it arrived. Each failure below appeared with that land and was not failing before it. Fix them on this branch and check the fix as you would any change; it lands like any other turn.";

// The prompt a breakage actually sends: its opening, then the failures, each already worded for the model.
export const landBreakagePrompt = (parts: readonly string[]): string => [LAND_BREAKAGE_OPENING, ...parts].join("\n\n");

// Whether a stored prompt is one.
export const isLandBreakage = (prompt: string): boolean => prompt.startsWith(LAND_BREAKAGE_OPENING);
