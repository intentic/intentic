import type { z } from "zod";
import type { ManifestProblem } from "./manifest-problems.js";

// A misspelled key (e.g. `hashlineEdit`) parses fine: Zod silently drops what a schema doesn't declare, so the feature
// stays off with no visible failure. Schemas stay loose rather than strict, since strict would also reject a manifest
// legitimately written by a newer build; the typo is reported instead.

// Levenshtein distance capped at `budget`, exiting early once a row exceeds it. Runs over a handful of short keys on a
// path that already did file IO.
const distance = (a: string, b: string, budget: number): number => {
    if (Math.abs(a.length - b.length) > budget) {
        return budget + 1;
    }
    let previous = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
        const row = [i, ...Array.from<number>({ length: b.length }).fill(0)];
        for (let j = 1; j <= b.length; j++) {
            const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
            row[j] = Math.min((row[j - 1] ?? 0) + 1, (previous[j] ?? 0) + 1, substitution);
        }
        // Every path through this row already exceeds budget; no later row can come back under it.
        if (Math.min(...row) > budget) {
            return budget + 1;
        }
        previous = row;
    }
    return previous[b.length] ?? budget + 1;
};

// Nearest known key to `stray`, or undefined if none is close. Budget scales with length (a third, floored at one)
// since a wrong guess costs more than no guess, and the same edit count means different things at different lengths.
export const nearestKey = (stray: string, known: readonly string[]): string | undefined => {
    const budget = Math.max(1, Math.floor(stray.length / 3));
    let best: { key: string; score: number } | undefined;
    for (const key of known) {
        const score = distance(stray.toLowerCase(), key.toLowerCase(), budget);
        if (score <= budget && (best === undefined || score < best.score)) {
            best = { key, score };
        }
    }
    return best?.key;
};

// Every key in a raw object the schema doesn't declare, each with a nearest-match guess; `known` is the schema's own
// key list, not a hand-copied one. A non-object value reports nothing: that's the wrong shape entirely, not a stray
// key.
// Parse function for a `z.object` manifest: validates against the schema and reports any undeclared key. Restricted to
// object schemas since a `z.record` manifest has no fixed keys to be unknown against.
export const objectParse =
    <S extends z.ZodObject>(schema: S) =>
    (raw: unknown, report: (problem: ManifestProblem) => void): z.infer<S> | undefined => {
        for (const problem of unknownKeyProblems(raw, Object.keys(schema.shape))) {
            report(problem);
        }
        return schema.safeParse(raw).data;
    };

export const unknownKeyProblems = (raw: unknown, known: readonly string[]): ManifestProblem[] => {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        return [];
    }
    const problems: ManifestProblem[] = [];
    for (const key of Object.keys(raw as Record<string, unknown>)) {
        if (known.includes(key)) {
            continue;
        }
        const suggestion = nearestKey(key, known);
        // Omitted, not undefined, when there's no guess: this crosses the wire and undefined needs special-casing.
        problems.push(suggestion === undefined ? { kind: "unknownKey", detail: key } : { kind: "unknownKey", detail: key, suggestion });
    }
    return problems;
};
