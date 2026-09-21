// Flag parsers whose rule is the same wherever the flag appears.

/**
 * A budget, a cap, a page count or a timeout: never negative, never Infinity, never NaN. stricli ships a
 * `numberParser`, and it accepts all three — a `--budget -5` parsed by it reaches the renderer as a negative cap.
 */
export const countParser = (raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`expected a non-negative number, got "${raw}"`);
    }
    return value;
};
