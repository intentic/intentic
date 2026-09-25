// A stored document's history as data: each conversion is a guarded, pure rewrite of the raw JSON a store reads, run
// before the schema on every read. The guard makes a conversion a no-op on a document already past it, so running the
// whole list over a document from any era converges on today's shape without the document carrying a version, and
// every door old bytes arrive through (an update, a bundle, a git revert, a history restore) is covered by the read.
// Two rules keep that sound, and the vocabulary below only offers moves that obey them: a change of meaning ships as a
// rename, never as a new reading of the same key; and a retired key is never reused.

// The only thing a conversion rewrites: one JSON object, never mutated, replaced along the branch that changed.
export type JsonObject = Record<string, unknown>;

export const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

// What one conversion did at one place in a document, for the ledger and the pre-flight plan. `at` is the path inside
// the document ("" is the document itself, "[3]" its fourth entry, "trigger" a nested object).
export interface ConversionChange {
    readonly conversion: string;
    readonly at: string;
    readonly detail?: string;
}

interface ConversionBase<Kind extends string> {
    readonly kind: Kind;
    // One line a person reads in a plan or the ledger: "renames agentRunModel to agentRunModels".
    readonly describe: string;
}

export interface RenameConversion<From extends string = string, To extends string = string> extends ConversionBase<"rename"> {
    readonly from: From;
    readonly to: To;
}

export interface DropConversion<Key extends string = string> extends ConversionBase<"drop"> {
    readonly key: Key;
}

export interface RetypeConversion<Key extends string = string, In = unknown, Out = unknown> extends ConversionBase<"retype"> {
    readonly key: Key;
    // True only for the OLD representation; a converted value must fail it, or the conversion would run twice.
    readonly guard: (value: unknown) => value is In;
    // Method syntax on purpose: the guard proves `In` at runtime, so a union of conversions may hold any input type.
    convert(value: In): Out;
}

export interface MapValueConversion<Key extends string = string, Mapping extends Readonly<Record<string, unknown>> = Readonly<Record<string, unknown>>>
    extends ConversionBase<"mapValue"> {
    readonly key: Key;
    readonly mapping: Mapping;
}

export interface PinDefaultConversion<Key extends string = string, Value = unknown> extends ConversionBase<"pinDefault"> {
    readonly key: Key;
    readonly value: Value;
}

export interface TransformConversion<In extends JsonObject = JsonObject, Out extends JsonObject = JsonObject> extends ConversionBase<"transform"> {
    // True only for the old shape; the output must fail it.
    readonly applies: (value: JsonObject) => value is In;
    // Method syntax on purpose, as for retype.
    convert(value: In): Out;
}

// Several keys become one (three optional fields folded into a ladder): the old keys go, the new one takes the place of
// the first of them.
export interface FoldConversion<From extends string = string, Into extends string = string, Out = unknown> extends ConversionBase<"fold"> {
    readonly from: readonly From[];
    readonly into: Into;
    // True only for the old shape; the folded output must fail it.
    readonly applies: (value: JsonObject) => boolean;
    // Method syntax on purpose, as for retype. `whole` is the object before folding, for a value derived from elsewhere.
    convert(fields: Readonly<Partial<Record<From, unknown>>>, whole: JsonObject): Out;
}

// Entries of a list this version withdrew (a capability kind that no longer exists): removed, each one recorded. Only
// for entries nothing can convert; one with a successor is converted instead (mapValue, fold).
export interface RetireEntriesConversion<Retired = unknown> extends ConversionBase<"retireEntries"> {
    readonly isRetired: (entry: unknown) => entry is Retired;
}

export interface AtConversion<Path extends string = string, Inner = unknown> extends ConversionBase<"at"> {
    // Dotted keys; `*` is every element of an array or every value of an object.
    readonly path: Path;
    readonly inner: Inner;
}

export type Conversion =
    | RenameConversion
    | DropConversion
    | RetypeConversion
    | MapValueConversion
    | PinDefaultConversion
    | TransformConversion
    | FoldConversion
    | RetireEntriesConversion
    | AtConversion<string, Conversion>;

// Where a document's conversions apply: the document itself, each entry of a top-level array, or each value of a
// top-level object keyed by id.
export type Granularity = "object" | "entries" | "record";

// The value a conversion leaves in a change record, short enough for a log line.
const glimpse = (value: unknown): string => {
    // String() over the result, since JSON.stringify answers undefined for a value JSON cannot spell.
    const spelled = String(JSON.stringify(value));
    return spelled.length > 80 ? `${spelled.slice(0, 77)}…` : spelled;
};

// Keeps key order: a renamed key takes its predecessor's place, so a tracked file's diff shows one line changing.
const renamedKey = (target: JsonObject, from: string, to: string): JsonObject =>
    Object.fromEntries(Object.entries(target).map(([key, value]) => [key === from ? to : key, value]));

const withoutKey = (target: JsonObject, key: string): JsonObject => Object.fromEntries(Object.entries(target).filter(([name]) => name !== key));

export const rename = <const From extends string, const To extends string>(from: From, to: To): RenameConversion<From, To> => ({
    kind: "rename",
    describe: `renames ${from} to ${to}`,
    from,
    to,
});

export const drop = <const Key extends string>(key: Key): DropConversion<Key> => ({ kind: "drop", describe: `drops ${key}`, key });

export const retype = <const Key extends string, In, Out>(
    key: Key,
    guard: (value: unknown) => value is In,
    convert: (value: In) => Out,
    describe = `converts ${key} to its new form`,
): RetypeConversion<Key, In, Out> => ({ kind: "retype", describe, key, guard, convert });

// A mapped value that is itself a key of the mapping would be mapped again on the next read.
export const mapValue = <const Key extends string, const Mapping extends Readonly<Record<string, unknown>>>(
    key: Key,
    mapping: Mapping,
): MapValueConversion<Key, Mapping> => {
    const cyclic = Object.values(mapping).filter((mapped): mapped is string => typeof mapped === "string" && Object.hasOwn(mapping, mapped));
    if (cyclic.length > 0) {
        throw new Error(`mapValue(${key}) maps onto its own keys (${cyclic.join(", ")}), so it would not settle`);
    }
    return { kind: "mapValue", describe: `converts ${key} from its old values`, key, mapping };
};

// For a changed schema default: an existing file that never set the key keeps the old behavior, a new one gets the new.
export const pinDefault = <const Key extends string, const Value>(key: Key, value: Value): PinDefaultConversion<Key, Value> => ({
    kind: "pinDefault",
    describe: `keeps the earlier default for ${key}`,
    key,
    value,
});

export const transform = <In extends JsonObject, Out extends JsonObject>(
    describe: string,
    applies: (value: JsonObject) => value is In,
    convert: (value: In) => Out,
): TransformConversion<In, Out> => ({ kind: "transform", describe, applies, convert });

export const fold = <const From extends string, const Into extends string, Out>(
    describe: string,
    shape: {
        readonly from: readonly From[];
        readonly into: Into;
        readonly applies: (value: JsonObject) => boolean;
        readonly convert: (fields: Readonly<Partial<Record<From, unknown>>>, whole: JsonObject) => Out;
    },
): FoldConversion<From, Into, Out> => ({ kind: "fold", describe, from: shape.from, into: shape.into, applies: shape.applies, convert: shape.convert });

// Every key a schema once had and no longer has, dropped: retired, not from the future, so passthrough stops carrying it
// and no later schema may reuse the name. A tuple, so the type-level replay sees each key.
export const dropAll = <const Keys extends readonly string[]>(keys: Keys): { readonly [I in keyof Keys]: DropConversion<Keys[I] & string> } =>
    keys.map((key) => drop(key)) as unknown as { readonly [I in keyof Keys]: DropConversion<Keys[I] & string> };

type Nested<Path extends string, History extends readonly Conversion[], Entries extends boolean> = {
    readonly [I in keyof History]: History[I] extends RetireEntriesConversion
        ? AtConversion<Path, History[I]>
        : AtConversion<Entries extends true ? `${Path}.*` : Path, History[I]>;
};

// One document's history applied where another document carries it (a definition's `settings` table, a bundle's
// embedded definition): one declaration, every carrier. `entries` for a carried list, whose entries each convert and
// whose retired entries leave the list.
export const nested = <const Path extends string, const History extends readonly Conversion[], const Entries extends boolean = false>(
    path: Path,
    history: History,
    entries?: Entries,
): Nested<Path, History, Entries> =>
    history.map((conversion) => at(conversion.kind === "retireEntries" || entries !== true ? path : `${path}.*`, conversion)) as unknown as Nested<
        Path,
        History,
        Entries
    >;

export const retireEntries = <Retired>(describe: string, isRetired: (entry: unknown) => entry is Retired): RetireEntriesConversion<Retired> => ({
    kind: "retireEntries",
    describe,
    isRetired,
});

export const at = <const Path extends string, const Inner extends Conversion>(path: Path, inner: Inner): AtConversion<Path, Inner> => ({
    kind: "at",
    describe: `${inner.describe} under ${path}`,
    path,
    inner,
});

type Report = (change: ConversionChange) => void;

// One conversion over one object: the same object back, by reference, when its guard says it does not apply.
const applyToObject = (conversion: Conversion, target: JsonObject, where: string, report: Report): JsonObject => {
    switch (conversion.kind) {
        case "rename": {
            if (!Object.hasOwn(target, conversion.from)) {
                return target;
            }
            if (!Object.hasOwn(target, conversion.to)) {
                report({ conversion: conversion.describe, at: where });
                return renamedKey(target, conversion.from, conversion.to);
            }
            // Both names holding the same value (a file a daemon before 2026-09-25 wrote under both during a rename's
            // grace window, or one edited by hand): nothing to report, nothing for the file to lose.
            if (JSON.stringify(target[conversion.from]) === JSON.stringify(target[conversion.to])) {
                return withoutKey(target, conversion.from);
            }
            // Both names present and different (an old key back through git, or a rolled-back build's edit):
            // the current name wins, and what the older one held is recorded rather than lost without a word.
            report({ conversion: conversion.describe, at: where, detail: `kept ${conversion.to}; ${conversion.from} held ${glimpse(target[conversion.from])}` });
            return withoutKey(target, conversion.from);
        }
        case "drop": {
            if (!Object.hasOwn(target, conversion.key)) {
                return target;
            }
            report({ conversion: conversion.describe, at: where, detail: `it held ${glimpse(target[conversion.key])}` });
            return withoutKey(target, conversion.key);
        }
        case "retype": {
            const value = target[conversion.key];
            if (!Object.hasOwn(target, conversion.key) || !conversion.guard(value)) {
                return target;
            }
            report({ conversion: conversion.describe, at: where });
            return { ...target, [conversion.key]: conversion.convert(value) };
        }
        case "mapValue": {
            const value = target[conversion.key];
            if (typeof value !== "string" || !Object.hasOwn(conversion.mapping, value)) {
                return target;
            }
            report({ conversion: conversion.describe, at: where, detail: `${glimpse(value)} became ${glimpse(conversion.mapping[value])}` });
            return { ...target, [conversion.key]: conversion.mapping[value] };
        }
        case "pinDefault": {
            if (Object.hasOwn(target, conversion.key)) {
                return target;
            }
            report({ conversion: conversion.describe, at: where });
            return { ...target, [conversion.key]: conversion.value };
        }
        case "transform": {
            if (!conversion.applies(target)) {
                return target;
            }
            report({ conversion: conversion.describe, at: where });
            return conversion.convert(target);
        }
        case "fold":
            return applyFold(conversion, target, where, report);
        case "retireEntries":
            // An object is not a list; retiring acts on the list holding it (applyOne, applyAt).
            return target;
        case "at":
            return applyAt(conversion.inner, conversion.path.split("."), target, where, report) as JsonObject;
    }
};

const applyFold = (conversion: FoldConversion, target: JsonObject, where: string, report: Report): JsonObject => {
    if (!conversion.applies(target)) {
        return target;
    }
    const folded = new Set<string>(conversion.from);
    const fields = Object.fromEntries(Object.entries(target).filter(([key]) => folded.has(key)));
    const entries = Object.entries(target);
    const first = entries.findIndex(([key]) => folded.has(key));
    const kept = entries.filter(([key]) => !folded.has(key) && key !== conversion.into);
    kept.splice(first === -1 ? kept.length : Math.min(first, kept.length), 0, [conversion.into, conversion.convert(fields, target)]);
    report({ conversion: conversion.describe, at: where });
    return Object.fromEntries(kept);
};

// Removes a list's withdrawn entries, by index for an array and by key for an object keyed by id.
const retireFrom = (conversion: RetireEntriesConversion, container: unknown, where: string, report: Report): unknown => {
    const retired = (entry: unknown, place: string): boolean => {
        if (!conversion.isRetired(entry)) {
            return false;
        }
        report({ conversion: conversion.describe, at: place, detail: glimpse(entry) });
        return true;
    };
    if (Array.isArray(container)) {
        const kept = container.filter((entry, index) => !retired(entry, joinWhere(where, `[${index}]`)));
        return kept.length === container.length ? container : kept;
    }
    if (!isJsonObject(container)) {
        return container;
    }
    const kept = Object.entries(container).filter(([key, entry]) => !retired(entry, joinWhere(where, key)));
    return kept.length === Object.keys(container).length ? container : Object.fromEntries(kept);
};

const joinWhere = (where: string, segment: string): string => (segment.startsWith("[") || where === "" ? `${where}${segment}` : `${where}.${segment}`);

// Every element of an array or every value of an object, rebuilt only where one of them changed.
const applyToEach = (visit: (value: unknown, where: string) => unknown, container: unknown, where: string): unknown => {
    if (Array.isArray(container)) {
        const next = container.map((value, index) => visit(value, joinWhere(where, `[${index}]`)));
        return next.some((value, index) => value !== container[index]) ? next : container;
    }
    if (!isJsonObject(container)) {
        return container;
    }
    const entries = Object.entries(container);
    const next = entries.map(([key, value]) => [key, visit(value, joinWhere(where, key))] as const);
    return next.some(([, value], index) => value !== entries[index]?.[1]) ? Object.fromEntries(next) : container;
};

const applyAt = (inner: Conversion, segments: readonly string[], value: unknown, where: string, report: Report): unknown => {
    const [head, ...rest] = segments;
    if (head === undefined) {
        if (inner.kind === "retireEntries") {
            return retireFrom(inner, value, where, report);
        }
        return isJsonObject(value) ? applyToObject(inner, value, where, report) : value;
    }
    if (head === "*") {
        return applyToEach((element, elementWhere) => applyAt(inner, rest, element, elementWhere, report), value, where);
    }
    if (!isJsonObject(value) || !Object.hasOwn(value, head)) {
        return value;
    }
    const child = value[head];
    const next = applyAt(inner, rest, child, joinWhere(where, head), report);
    return next === child ? value : { ...value, [head]: next };
};

// One conversion over a whole document, at its granularity.
const applyOne = (conversion: Conversion, granularity: Granularity, value: unknown, report: Report): unknown => {
    if (conversion.kind === "retireEntries" && granularity !== "object") {
        return retireFrom(conversion, value, "", report);
    }
    if (granularity === "object") {
        return isJsonObject(value) ? applyToObject(conversion, value, "", report) : value;
    }
    const container = granularity === "entries" ? Array.isArray(value) : isJsonObject(value);
    return container ? applyToEach((entry, where) => (isJsonObject(entry) ? applyToObject(conversion, entry, where, report) : entry), value, "") : value;
};

export class ConversionError extends Error {
    readonly conversion: string;

    constructor(conversion: string, cause: unknown) {
        super(`conversion "${conversion}" failed: ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
        this.name = "ConversionError";
        this.conversion = conversion;
    }
}

// Every conversion in declaration order; a throw is named after the conversion that threw, not the last that reported.
const applyAll = (conversions: readonly Conversion[], granularity: Granularity, raw: unknown, report: Report): unknown => {
    let value = raw;
    for (const conversion of conversions) {
        try {
            value = applyOne(conversion, granularity, value, report);
        } catch (error) {
            throw new ConversionError(conversion.describe, error);
        }
    }
    return value;
};

export interface Converted {
    readonly value: unknown;
    readonly changes: readonly ConversionChange[];
}

// `checkSettles` runs the list a second time over its own output and fails a conversion that is not a no-op there: what
// a development build turns on, so the first read that reaches such a conversion fails instead of every read after it
// quietly rewriting the file.
export const convertDocument = (conversions: readonly Conversion[], granularity: Granularity, raw: unknown, checkSettles = false): Converted => {
    if (conversions.length === 0) {
        return { value: raw, changes: [] };
    }
    const changes: ConversionChange[] = [];
    const value = applyAll(conversions, granularity, raw, (change) => changes.push(change));
    if (checkSettles && changes.length > 0) {
        const again: ConversionChange[] = [];
        const settled = applyAll(conversions, granularity, value, (change) => again.push(change));
        if (settled !== value || again.length > 0) {
            throw new ConversionError(again[0]?.conversion ?? "unknown", new Error("it changed its own output, so it would run on every read"));
        }
    }
    return { value, changes };
};

// A document's conversions as one-line descriptions, for a plan that has nothing to convert but still names the chain.
export const describeConversions = (conversions: readonly Conversion[]): string[] => conversions.map((conversion) => conversion.describe);
