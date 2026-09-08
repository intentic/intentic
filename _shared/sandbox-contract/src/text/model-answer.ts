// Four callers ask a model for a one-line answer and always strip what wraps it (a code fence, a label prefix, a list
// bullet) rather than reject it. The label pattern isn't shared, since each caller strips a different word. Lives here,
// not beside a caller, since the callers span two daemon subsystems that can't import each other.

// A fenced block's open (with/without a language) and close; `.replace` only, `g` makes test/exec stateful.
export const FENCE = /^```[\w-]*\n?|\n?```$/gu;

// A leading list marker, for the answer returned as a list of one.
export const BULLET = /^[-*]\s+/u;
