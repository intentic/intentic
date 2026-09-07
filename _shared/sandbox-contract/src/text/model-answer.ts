/* UNWRAPPING WHAT A MODEL PUT AROUND A ONE-LINE ANSWER.
 *
 * Four places ask a model for a single short string — a session title, a commit subject, a persona id, a
 * command verdict — and every one of them gets it back dressed up: fenced as if it were code, prefixed with
 * the label it was asked for ("Title: …"), or bulleted as if it were a list of one. The instinct is strong
 * enough that saying "no formatting" in the prompt does not stop it.
 *
 * All four strip it rather than refuse: the answer is right and only its packaging is wrong, and a helper that
 * rejects a good answer over a pair of backticks is worse than one that unwraps it.
 *
 * The wrappers are stated here because they are one fact about how models behave, not four. They had drifted
 * on the `u` flag alone (two `/g`, two `/gu`), which is harmless for these patterns and exactly the kind of
 * difference that makes a reader wonder whether the sites disagree on something that matters.
 *
 * The LABEL is deliberately NOT here: each caller asked for a different word and must strip its own, and a
 * shared label pattern would be a list of every prompt in the daemon, growing at each new one.
 *
 * In the contract rather than beside one of the callers because they sit in two of the daemon's subsystems
 * (`agent` and `git`), and a value import between those two is the cycle daemon-boundaries.mjs exists to
 * refuse. This is a fact about model output, which is contract-shaped anyway. */

// A fenced block's opening (with or without a language) and its closing. `.replace` only — this carries `g`,
// so `test`/`exec` on it would be stateful across call sites.
export const FENCE = /^```[\w-]*\n?|\n?```$/gu;

// A leading list marker, for the answer returned as a list of one.
export const BULLET = /^[-*]\s+/u;
