import { isJsonObject, type JsonObject } from "./conversions.js";

// Carries into a write what the file held that this build's parse dropped: keys a newer build added, and entries this
// build cannot read. Loose schemas already let an older build READ a newer file; without this, its next write would
// quietly delete everything it did not understand, so a rollback cost the newer version's data on the first save.
// What counts as "unknown" is exactly what parse stripped, so a key this build knows and the change removed stays gone,
// and a key a conversion retired (drop, rename) was removed before parse and is never carried.

// A key whose value names which arm of a union an object is: an object that switched arms carries nothing across, since
// the old arm's extra keys mean nothing on the new one.
const DISCRIMINATORS = ["kind", "type"] as const;

const sameArm = (parsed: JsonObject, updated: JsonObject): boolean =>
    DISCRIMINATORS.every((key) => typeof parsed[key] !== "string" || parsed[key] === updated[key]);

// Which keys name an entry, tried in order: most entries carry `id`, a few (workflow runs) their own.
export type IdKeys = readonly string[];
const DEFAULT_ID_KEYS: IdKeys = ["id"];

const carryObject = (raw: JsonObject, parsed: JsonObject, updated: JsonObject, idKeys: IdKeys): JsonObject => {
    if (!sameArm(parsed, updated)) {
        return updated;
    }
    let result: JsonObject | undefined;
    for (const [key, value] of Object.entries(raw)) {
        if (!Object.hasOwn(updated, key)) {
            // Stripped by parse and not set by the change: a key from a newer build (or a typo, which stays reported).
            if (!Object.hasOwn(parsed, key)) {
                result ??= { ...updated };
                result[key] = value;
            }
            continue;
        }
        if (Object.hasOwn(parsed, key)) {
            const carried = carryUnknown(value, parsed[key], updated[key], idKeys);
            if (carried !== updated[key]) {
                result ??= { ...updated };
                result[key] = carried;
            }
        }
    }
    return result ?? updated;
};

const idOf = (value: unknown, idKeys: IdKeys): string | undefined => {
    if (!isJsonObject(value)) {
        return undefined;
    }
    const id = idKeys.map((key) => value[key]).find((candidate) => typeof candidate === "string");
    return typeof id === "string" ? id : undefined;
};

// Pairs each written element with the raw element it came from: by reference when the change kept the parsed object,
// by id when it rebuilt it. Only a parse that kept every element lines raw up with parsed by position.
const carryArray = (raw: readonly unknown[], parsed: readonly unknown[], updated: readonly unknown[], idKeys: IdKeys): readonly unknown[] => {
    if (raw.length !== parsed.length) {
        return updated;
    }
    const rawOfParsed = new Map<unknown, unknown>();
    const indexOfId = new Map<string, number>();
    parsed.forEach((element, index) => {
        if (typeof element === "object" && element !== null) {
            rawOfParsed.set(element, raw[index]);
        }
        const id = idOf(element, idKeys);
        if (id !== undefined) {
            indexOfId.set(id, index);
        }
    });
    let result: unknown[] | undefined;
    updated.forEach((element, index) => {
        const byId = indexOfId.get(idOf(element, idKeys) ?? "");
        const [source, before] = rawOfParsed.has(element) ? [rawOfParsed.get(element), element] : byId === undefined ? [undefined, undefined] : [raw[byId], parsed[byId]];
        if (source === undefined) {
            return;
        }
        const carried = carryUnknown(source, before, element, idKeys);
        if (carried !== element) {
            result ??= [...updated];
            result[index] = carried;
        }
    });
    return result ?? updated;
};

// `raw` is the file as read (after conversions), `parsed` what the schema made of it, `updated` what the change returns.
// Answers `updated` itself, by reference, when nothing needs carrying.
export const carryUnknown = (raw: unknown, parsed: unknown, updated: unknown, idKeys: IdKeys = DEFAULT_ID_KEYS): unknown => {
    if (isJsonObject(raw) && isJsonObject(parsed) && isJsonObject(updated)) {
        return carryObject(raw, parsed, updated, idKeys);
    }
    if (Array.isArray(raw) && Array.isArray(parsed) && Array.isArray(updated)) {
        return carryArray(raw, parsed, updated, idKeys);
    }
    return updated;
};

// An entry list read one entry at a time: the entries this build can use, the raw entries lined up with them, and the
// ones it could not read, each at the index it held.
export interface EntryRead<E> {
    readonly entries: E[];
    readonly aligned: readonly unknown[];
    readonly quarantined: readonly { readonly index: number; readonly entry: unknown }[];
}

export const readEntries = <E>(raw: readonly unknown[], parseEntry: (entry: unknown) => E | undefined): EntryRead<E> => {
    const entries: E[] = [];
    const aligned: unknown[] = [];
    const quarantined: { index: number; entry: unknown }[] = [];
    raw.forEach((entry, index) => {
        const parsed = parseEntry(entry);
        if (parsed === undefined) {
            quarantined.push({ index, entry });
            return;
        }
        entries.push(parsed);
        aligned.push(entry);
    });
    return { entries, aligned, quarantined };
};

// Puts the entries this build could not read back into what it writes, near where they were; one the write now holds a
// same-id entry for was replaced on purpose and stays out.
export const reemitQuarantined = (
    updated: readonly unknown[],
    quarantined: EntryRead<unknown>["quarantined"],
    idKeys: IdKeys = DEFAULT_ID_KEYS,
): readonly unknown[] => {
    const written = new Set(updated.map((entry) => idOf(entry, idKeys)).filter((id) => id !== undefined));
    const kept = quarantined.filter(({ entry }) => !written.has(idOf(entry, idKeys) ?? "\u0000"));
    if (kept.length === 0) {
        return updated;
    }
    const result = [...updated];
    for (const { index, entry } of kept) {
        result.splice(Math.min(index, result.length), 0, entry);
    }
    return result;
};
