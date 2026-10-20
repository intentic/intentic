// What every runtime's loop shares about waiting out a vendor and explaining its exit: how long a rate limit is waited out
// in-turn, and a process's stderr folded into the sentence it explains. How a failure's words are read is error-frames.ts
// (codedFailure), once for every runtime.

// How long any loop may wait out a rate limit inside a turn before the turn hands the wait to the daemon, which holds
// the conversation and books it for the reset (classify-failure.ts) instead of keeping a turn open on nothing. One
// figure for every runtime that waits in-turn: OpenCode reads the wait it scheduled, Codex counts from the refusal,
// since its notice ("Reconnecting... 1/5") names no wait at all.
export const RATE_LIMIT_PATIENCE_MS = 2 * 60_000;

// A failure with its process's stderr tail folded in, so a bare exit code becomes the actual reason.
export const withStderrTail = (message: string, stderrTail: string): string => {
    const detail = stderrTail.trim();
    return detail === "" ? message : `${message}: ${detail}`;
};
