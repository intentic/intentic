import type { z } from "zod";
import type { ManifestProblem } from "./manifest-problems.js";

/* THE TYPO THAT PARSES. Zod strips what a schema does not declare and reports success, so a settings file
 * carrying `terseOutpt` is read as a settings file that never mentioned terse output, the write succeeds, the
 * flag stays off, and the only evidence is a key sitting in the file doing nothing.
 *
 * It is the worst of the three ways a manifest can be wrong (see manifest-problems.ts) precisely because
 * nothing looks broken. A file that will not parse at least fails loudly enough to be noticed once someone
 * checks; this one survives every check and quietly withholds one feature.
 *
 * Making the schemas strict instead would be the wrong fix twice over. It would refuse the whole file over one
 * stray key (a wider failure than the one it is trying to fix) and it would break the case the loose
 * parse exists FOR: a manifest written by a NEWER build, which legitimately carries keys this one has never
 * heard of and must still be read (the same rollback story json-file.ts protects the bytes for). So the parse
 * stays loose and the surprise gets reported instead. */

/* One edit apart or not, capped, the classic Levenshtein, stopped early once the whole row exceeds the budget
 * we would accept anyway. Two short strings, run over a few dozen keys at most, on a path that already did
 * file IO: there is nothing here worth optimising past the early exit. */
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
        // Every way of reaching the end of this row already costs more than we would report, no later row can
        // come back under it, so stop.
        if (Math.min(...row) > budget) {
            return budget + 1;
        }
        previous = row;
    }
    return previous[b.length] ?? budget + 1;
};

/* The known key a stray one was probably MEANT to be, or undefined when nothing is close enough.
 *
 * The budget scales with the name's length rather than being a flat number of edits, because the same two
 * edits mean different things at different scales: `iq` → `id` is a different word, while
 * `stableSystemPromt` → `stableSystemPrompt` is obviously a slip. A third of the length, floored at one, is
 * the line, and it is deliberately conservative, because a confident wrong guess ("did you mean `skills`?")
 * costs more than no guess at all: it sends someone to edit a line that was never the problem. */
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

/* Every key in a raw manifest object that the schema does not declare, each with its best guess. `known` is
 * the schema's own key list, so this cannot drift from what is actually accepted, callers pass
 * `Object.keys(Schema.shape)` rather than a second, hand-written copy of the same names.
 *
 * A raw value that is not a plain object reports nothing: that is not a stray key, it is a file of the wrong
 * shape entirely, which the schema will reject whole and json-file.ts will report as unreadable. */
/* A `jsonFile` parse function for a manifest with a FIXED set of keys, validate against the schema, and
 * report anything the file carried that the schema never declared.
 *
 * Deliberately restricted to `z.object`. The other manifests are keyed by something the user chose, an
 * extension id, an account, a thread, and on a `z.record` every key is "unknown" to the shape by design, so
 * the same check there would report the file's entire contents as a set of typos. The type signature is what
 * enforces that: a store can only reach this helper by handing it a schema that HAS a fixed shape.
 *
 * It also replaces the `parse: (raw) => Schema.safeParse(raw).data` one-liner rather than adding a line beside
 * it, so a store opts in by getting shorter. */
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
        // The key is OMITTED rather than set to undefined when there is no guess: this goes over the wire, and
        // an explicit `suggestion: undefined` is the difference between "we have no idea" and a field the
        // browser has to special-case.
        problems.push(suggestion === undefined ? { kind: "unknownKey", detail: key } : { kind: "unknownKey", detail: key, suggestion });
    }
    return problems;
};
