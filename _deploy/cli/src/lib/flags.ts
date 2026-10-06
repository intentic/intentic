// Numeric flag parsers. stricli's `numberParser` accepts NaN, Infinity, negatives and fractions, so
// `--maxIterations NaN` once reached the reconcile loop and reported "did not converge within NaN iterations".
// Every numeric flag of this CLI is a count, parsed here (the same rule as agent-cli's countParser, plus whole numbers).

// A whole number no smaller than `min`; anything else is refused with the text that was typed.
export const countAtLeast =
    (min: number) =>
    (raw: string): number => {
        const value = Number(raw);
        if (raw.trim() === "" || !Number.isSafeInteger(value) || value < min) {
            throw new Error(`expected a whole number of at least ${min}, got "${raw}"`);
        }
        return value;
    };
