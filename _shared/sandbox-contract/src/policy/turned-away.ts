/* THE REFUSALS THAT TURN A WHOLE TURN AWAY AT THE DOOR: refused before the model saw a word, so nothing ran and the
   message is still owed to somebody — the composer that sent it, or the sandbox that started the turn itself. */

// A set rather than a run of case labels: what they share is a fact about the turn, not a shape.
const TURNED_AWAY: ReadonlySet<string> = new Set([
    "claude-reauth",
    "unknown-command",
    "context-window-too-small",
    "sandbox-memory-low",
    "trial-unavailable",
    "trial-model-unavailable",
    "trial-exhausted",
    "model-unavailable",
    "engine-version-floor",
]);

/** Whether a failure code refuses a turn before the model sees any of it. */
export const turnedAwayCode = (code: string | undefined): boolean => code !== undefined && TURNED_AWAY.has(code);
