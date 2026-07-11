// Conservative token estimate for budget enforcement — ~4 chars/token holds for code and prose alike, and the
// property tests assert the rendered output never exceeds the budget under this estimate.
export const estimateTokens = (text: string): number => Math.ceil(text.length / 4);
