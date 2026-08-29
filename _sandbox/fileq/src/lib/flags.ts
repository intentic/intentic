/* Flag parsers shared across commands — declared once so the verbs cannot drift apart on options that mean
 * the same thing (webq's convention, kept). */

export const numberParser = (raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`expected a non-negative number, got "${raw}"`);
    }
    return value;
};
