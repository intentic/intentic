// What every runtime's loop shares about waiting out a vendor: how long a rate limit is waited out in-turn. A process's
// stderr is folded into the sentence it explains by withStderrTail (engines/failure-sentences.ts), beside what reads the
// sentence back without it; how a failure's words are read is error-frames.ts (codedFailure), once for every runtime.

// How long any loop may wait out a rate limit inside a turn before the turn hands the wait to the daemon, which holds
// the conversation and books it for the reset (classify-failure.ts) instead of keeping a turn open on nothing. One
// figure for every runtime that waits in-turn: OpenCode reads the wait it scheduled, Codex counts from the refusal,
// since its notice ("Reconnecting... 1/5") names no wait at all.
export const RATE_LIMIT_PATIENCE_MS = 2 * 60_000;
