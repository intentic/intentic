/* Shared flag parsers keep command verbs consistent on equivalent options. */

export const numberParser = (raw: string): number => {
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) {
        throw new Error(`expected a non-negative number, got "${raw}"`);
    }
    return value;
};
