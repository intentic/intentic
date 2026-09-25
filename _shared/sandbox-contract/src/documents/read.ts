import type { ManifestProblem } from "../schemas/system.js";
import { type Conversion, convertDocument, type Granularity } from "./conversions.js";
import { carryUnknown, type IdKeys, reemitQuarantined } from "./passthrough.js";

// The one reading of a stored document, shared by every store that keeps a file across versions: the daemon's
// jsonFile, jsonEntries and jsonDir, and an extension's sandboxDocument. The bytes as JSON, then the document's
// conversions, then this build's parse; what it could not read is named by a `reason` a reader matches on, never by its
// wording; and a change to what it read comes back through `carry`, which keeps what this build's parse dropped.

// What a reader needs of a document: the conversions its shape has had, and where they apply.
export interface DocumentShape {
    readonly history: readonly Conversion[];
    readonly granularity: Granularity;
}

type Report = (problem: ManifestProblem) => void;

export type DocumentParse<T> =
    // The whole file as one value, undefined for one this build cannot read; `report` flags a problem within a valid one.
    | { readonly kind: "whole"; readonly parse: (raw: unknown, report: Report) => T | undefined }
    // A top-level array read one entry at a time: an entry this build cannot read, or whose conversion fails, is
    // reported and quarantined (kept as written on the next save), never the file. `idKeys` pair a rebuilt entry with
    // the one it replaces.
    | {
          readonly kind: "entries";
          readonly entry: (raw: unknown, report: Report) => (T extends readonly (infer E)[] ? E : never) | undefined;
          readonly idKeys?: IdKeys;
      };

export interface DocumentRead<T> {
    // Undefined when the file as a whole is unreadable; `problems` then leads with why.
    readonly value: T | undefined;
    // The bytes a change to `value` writes: the change, plus what the file held that this build does not know.
    readonly carry: (updated: T) => unknown;
    readonly problems: readonly ManifestProblem[];
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const unreadable = <T>(reason: NonNullable<ManifestProblem["reason"]>, detail: string): DocumentRead<T> => ({
    value: undefined,
    carry: (updated) => updated,
    problems: [{ kind: "unreadable", reason, detail }],
});

// `checkSettles` is the daemon's development-build check (conversions.ts), off for an extension.
export const readDocument = <T>(text: string, shape: DocumentShape, how: DocumentParse<T>, checkSettles = false): DocumentRead<T> => {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return unreadable("not-json", "the file is not valid JSON");
    }
    const problems: ManifestProblem[] = [];
    const report: Report = (problem) => problems.push(problem);
    if (how.kind === "entries") {
        if (!Array.isArray(raw)) {
            return unreadable("rejected", "the file does not match what this build expects");
        }
        const perEntry = shape.granularity === "entries";
        const entries: unknown[] = [];
        const aligned: unknown[] = [];
        const quarantined: { index: number; entry: unknown }[] = [];
        let whole: readonly unknown[] = raw;
        if (!perEntry && shape.history.length > 0) {
            try {
                const converted = convertDocument(shape.history, shape.granularity, raw, checkSettles).value;
                whole = Array.isArray(converted) ? converted : [];
            } catch (error) {
                return unreadable("conversion-failed", `a conversion to this build's shape failed (${message(error)})`);
            }
        }
        whole.forEach((written, index) => {
            let candidates: readonly unknown[];
            try {
                const value = perEntry ? convertDocument(shape.history, "entries", [written], checkSettles).value : [written];
                candidates = Array.isArray(value) ? value : [value];
            } catch (error) {
                quarantined.push({ index, entry: written });
                report({
                    kind: "invalidEntry",
                    reason: "conversion-failed",
                    detail: `entry ${index} could not be converted to this build's shape (${message(error)}); it is kept as written`,
                });
                return;
            }
            for (const candidate of candidates) {
                const parsed = how.entry(candidate, report);
                if (parsed === undefined) {
                    quarantined.push({ index, entry: candidate });
                    report({ kind: "invalidEntry", reason: "rejected", detail: `entry ${index} is not one this build can read; it is kept as written` });
                    continue;
                }
                entries.push(parsed);
                aligned.push(candidate);
            }
        });
        return {
            value: entries as T,
            carry: (updated) => reemitQuarantined(carryUnknown(aligned, entries, updated, how.idKeys) as readonly unknown[], quarantined, how.idKeys),
            problems,
        };
    }
    try {
        raw = convertDocument(shape.history, shape.granularity, raw, checkSettles).value;
    } catch (error) {
        return unreadable("conversion-failed", `a conversion to this build's shape failed (${message(error)})`);
    }
    const value = how.parse(raw, report);
    if (value === undefined) {
        return unreadable("rejected", "the file does not match what this build expects");
    }
    return { value, carry: (updated) => carryUnknown(raw, value, updated), problems };
};
