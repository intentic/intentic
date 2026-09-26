/* THE REFUSALS THAT TURN A WHOLE TURN AWAY AT THE DOOR: refused before the model saw a word, so nothing ran and the
   message is still owed to somebody — the conversation's queue, held, for words a person sent, or the sandbox that
   started the turn itself. */

// A set rather than a run of case labels: what they share is a fact about the turn, not a shape.
const TURNED_AWAY: ReadonlySet<string> = new Set([
    "claude-reauth",
    // An organisation turned the account's Claude Code access off, or no account of the provider can serve: the next
    // turn is routed off it (the daemon's blocked-account route), so the words wait for it rather than being spent.
    "claude-not-entitled",
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
