// Types for token-estimate.mjs, the build-step-free copy of @intentic/base's token estimate.

// Estimated tokens of `text`: 0 for empty, at least 1 otherwise.
export const estimateTokens: (text: string) => number;

// The longest prefix of `text` whose estimate is at most `budget`, cut between pieces; the whole text when it fits.
export const sliceToTokens: (text: string, budget: number) => string;
