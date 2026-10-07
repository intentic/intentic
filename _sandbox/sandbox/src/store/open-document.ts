import { appendFile, mkdir, open, readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { z } from "zod";
import { type Conversion, convertDocument, type Granularity, isJsonObject } from "./evolution/conversions.js";
import type { DocumentSpec } from "./evolution/documents.js";
import { type IdListStore, idListFile } from "./id-list-file.js";
import { type JsonDir, jsonDir } from "./json-dir.js";
import { type JsonEntriesOptions, type JsonFile, type JsonFileOptions, jsonEntries, jsonFile } from "./json-file.js";
import type { IdKeys } from "./evolution/passthrough.js";
import { objectParse } from "./manifest/unknown-keys.js";

// Every store opens its file through the document that describes it: the parse is the document's own schema, laid out
// by its granularity (the whole file, one entry of a list, one value of a record keyed by id, one file of a directory),
// and its conversions run on every read. What a store adds is only what the spec cannot say: its fallback, a mapping
// from the schema's value to the store's own, a file mode, and whether an unreadable file may be set aside. A file no
// document describes is a cache (`cacheFile`), which carries nothing across versions and says so. Every handle on one
// path shares that path's write queue (queueOnFile), so a store opens a handle wherever it needs one; none is memoized.

type Parse<T> = JsonFileOptions<T>["parse"];
type Report = Parameters<Parse<never>>[1];

// Any document, whatever its schema, history or layout.
type AnyDocument<Layout extends Granularity = Granularity, Directory extends boolean = boolean> = DocumentSpec<
    z.ZodType,
    readonly Conversion[],
    readonly string[],
    Layout,
    Directory
>;

// One unit of the document as its schema reads it: the whole file, one entry, one record value, one directory file.
export type DocumentUnit<D> = D extends DocumentSpec<infer Schema> ? z.output<Schema> : never;

// The whole file as the document's layout makes it of that unit.
export type DocumentValue<D> =
    D extends DocumentSpec<infer Schema, readonly Conversion[], readonly string[], infer Layout>
        ? Layout extends "entries"
            ? z.output<Schema>[]
            : Layout extends "record"
              ? Record<string, z.output<Schema>>
              : z.output<Schema>
        : never;

export interface OpenOptions<V, T> {
    // Stands in for a file that is absent or this build cannot read; a function so no two reads share one instance.
    readonly fallback: () => NoInfer<T>;
    // The store's own value from the schema's, when the two differ (an optional field spelled for exact types, a
    // filter); undefined reads as unreadable. Absent, the schema's value is the store's.
    readonly read?: (value: V, report: Report) => T | undefined;
    // A reading more forgiving than the schema, for a file where one bad entry must not cost the rest (a members list
    // one malformed grant would otherwise empty): still answers the schema's own value, so the typecheck's claims about
    // the schema hold for what it returns. Absent, the schema reads the file.
    readonly lenient?: Parse<V>;
    // Report each key today's schema does not declare: a manifest a person edits, where a misspelled key would
    // otherwise be dropped in silence.
    readonly unknownKeys?: boolean;
    readonly mode?: number;
    // Refuse rather than set aside a write over content this build could not read: a file nothing can regrow.
    readonly onUnreadable?: "setAside" | "refuse";
}

// A record of the document's unit, keyed by id: one value this build cannot read makes the record unreadable, as a
// schema of the whole record would.
const recordParse =
    <D extends AnyDocument>(spec: D): Parse<DocumentValue<D>> =>
    (raw) => {
        if (!isJsonObject(raw)) {
            return undefined;
        }
        const values: Record<string, DocumentUnit<D>> = {};
        for (const [key, value] of Object.entries(raw)) {
            const parsed = spec.schema.safeParse(value);
            if (!parsed.success) {
                return undefined;
            }
            // SAFETY: parsed by the document's own schema, whose output is DocumentUnit<D> by definition.
            values[key] = parsed.data as DocumentUnit<D>;
        }
        // SAFETY: a record layout's value is exactly a record of its unit (DocumentValue).
        return values as DocumentValue<D>;
    };

// The schema that reads the whole file for a whole-file layout: the document's own, or a record of it.
const wholeParse = <D extends AnyDocument>(spec: D, unknownKeys: boolean): Parse<DocumentValue<D>> => {
    if (spec.granularity === "record") {
        return recordParse(spec);
    }
    if (unknownKeys && "shape" in spec.schema) {
        // SAFETY: a schema with a shape is a zod object, and an object layout's value is that object's output.
        const reporting = objectParse(spec.schema as z.ZodObject);
        // SAFETY: the same parse; its value is the document schema's own output (DocumentValue).
        return (raw, report) => reporting(raw, report) as DocumentValue<D> | undefined;
    }
    // SAFETY: an object layout's value is the document schema's own output (DocumentValue).
    return (raw) => spec.schema.safeParse(raw).data as DocumentValue<D> | undefined;
};

const layoutError = (spec: AnyDocument, wanted: string): Error =>
    new Error(`${spec.root}:${spec.path} is laid out as ${spec.directory ? "a directory" : spec.granularity}, not ${wanted}`);

// A document stored whole: one object, or a record of values keyed by id.
export const openDocument = <D extends AnyDocument<"object" | "record", false>, T = DocumentValue<D>>(
    spec: D,
    path: string,
    options: OpenOptions<DocumentValue<D>, T>,
): JsonFile<T> => {
    const { fallback, read, lenient, unknownKeys, ...writes } = options;
    // Checked again at runtime: a spec's layout types are only as literal as its definition spelled them.
    const layout: AnyDocument = spec;
    if (layout.directory || layout.granularity === "entries") {
        throw layoutError(spec, "a whole file");
    }
    const parse = lenient ?? wholeParse(spec, unknownKeys === true);
    const toStore = (value: DocumentValue<D>, report: Report): T | undefined => {
        if (read !== undefined) {
            return read(value, report);
        }
        // SAFETY: with no `read`, T is DocumentValue<D> itself (its default), the one type a store may then name.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- T is a type parameter the default ties to this value; no single assertion can say so
        return value as unknown as T;
    };
    return jsonFile<T>(path, {
        ...writes,
        parse: (raw, report) => {
            const value = parse(raw, report);
            return value === undefined ? undefined : toStore(value, report);
        },
        fallback,
        document: spec,
    });
};

export interface EntriesOptions<U, E> {
    // The store's own entry from the schema's; undefined quarantines the entry like one the schema refuses.
    readonly read?: (entry: U, report: Report) => E | undefined;
    readonly mode?: number;
    readonly onUnreadable?: "setAside" | "refuse";
    // The keys that name an entry, `id` unless the entries use another (a workflow run's `runId`).
    readonly idKeys?: IdKeys;
    // Unreadable as a whole when any entry is, rather than skipping it and writing it back as it stands.
    readonly strict?: boolean;
}

// A document stored as a list, read one entry at a time.
export const openEntries = <D extends AnyDocument<"entries", false>, E = DocumentUnit<D>>(
    spec: D,
    path: string,
    options: EntriesOptions<DocumentUnit<D>, E> = {},
): JsonFile<E[]> => {
    const { read, ...rest } = options;
    if (spec.directory || spec.granularity !== "entries") {
        throw layoutError(spec, "a list of entries");
    }
    const entry: JsonEntriesOptions<E>["entry"] = (raw, report) => {
        const parsed = spec.schema.safeParse(raw);
        if (!parsed.success) {
            return undefined;
        }
        // SAFETY: parsed by the document's own schema, whose output is DocumentUnit<D>.
        const unit = parsed.data as DocumentUnit<D>;
        if (read !== undefined) {
            return read(unit, report);
        }
        // SAFETY: with no `read`, E is DocumentUnit<D> itself (its default).
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- E is a type parameter the default ties to this value; no single assertion can say so
        return unit as unknown as E;
    };
    return jsonEntries<E>(path, { ...rest, entry, document: spec });
};

// A list of entries keyed by `id`, edited one entry at a time (personas, areas, capabilities).
export const openIdList = <D extends AnyDocument<"entries", false>>(
    spec: D,
    path: string,
    onInvalid?: (id: string, reason: string) => void,
): IdListStore<DocumentUnit<D> & { readonly id: string }> => {
    if (spec.directory || spec.granularity !== "entries") {
        throw layoutError(spec, "a list of entries");
    }
    // SAFETY: an id list's schema reads entries that carry an id, which its store keys by.
    const schema = spec.schema as z.ZodType<DocumentUnit<D> & { readonly id: string }>;
    return idListFile(path, schema, onInvalid, spec);
};

// A document stored as a directory of one file per entry.
export const openDirectory = <D extends AnyDocument<Granularity, true>>(spec: D, dir: string): JsonDir<DocumentUnit<D>> => {
    if (!spec.directory) {
        throw layoutError(spec, "a directory");
    }
    // SAFETY: each file is one unit, parsed by the document's own schema.
    const parse: Parameters<typeof jsonDir<DocumentUnit<D>>>[1] = (raw) => spec.schema.safeParse(raw).data as DocumentUnit<D> | undefined;
    return jsonDir<DocumentUnit<D>>(dir, parse, spec);
};

// An append-only ledger: written a line at a time, read whole.
export interface Ledger<E> {
    // Every entry this build can read, oldest first; [] for an absent ledger, and a throw for one that exists and cannot
    // be read, never an empty answer.
    readonly read: () => Promise<E[]>;
    // One line at the end; the store serializes its own appends.
    readonly append: (entry: E) => Promise<void>;
}

// One line of a ledger as today's entry: through the document's conversions, then its schema. Undefined for a torn line
// (a crash mid-append), one whose conversion fails, or one this build cannot read: it costs itself, never the ledger.
const ledgerEntry = <D extends AnyDocument<"entries", false>>(spec: D, line: string): DocumentUnit<D> | undefined => {
    try {
        // SAFETY: an "entries" conversion maps each element of the array it is given, so it answers an array.
        const [converted] = convertDocument(spec.history, "entries", [JSON.parse(line)]).value as unknown[];
        const parsed = spec.schema.safeParse(converted);
        // SAFETY: parsed by the document's own schema, whose output is DocumentUnit<D>.
        return parsed.success ? (parsed.data as DocumentUnit<D>) : undefined;
    } catch {
        // allow(silent-catch): an unreadable line is one lost entry by design, the rest of the ledger still reads
        return undefined;
    }
};

// A ledger whose last line a crash cut short has no newline after it, and the next line appended would be glued onto the
// fragment and lost with it. So the first append a process makes to a ledger ends that line first; checked once per
// path, since every line appended after it ends itself. Shared by every handle on the path, so two first appends wait
// on one check rather than each adding a newline.
const tailsMended = new Map<string, Promise<void>>();

const mendTail = async (path: string): Promise<void> => {
    const handle = await open(path, "r").catch(undefinedIfMissing);
    if (handle === undefined) {
        return;
    }
    try {
        const { size } = await handle.stat();
        if (size === 0) {
            return;
        }
        const { buffer } = await handle.read(Buffer.alloc(1), 0, 1, size - 1);
        if (buffer[0] !== 0x0a) {
            await appendFile(path, "\n");
        }
    } finally {
        await handle.close();
    }
};

const tailMended = (path: string): Promise<void> => {
    const key = resolve(path);
    let mended = tailsMended.get(key);
    if (mended === undefined) {
        // A check that failed is asked again by the next append rather than failing every append after it.
        mended = mendTail(path).catch((error: unknown) => {
            tailsMended.delete(key);
            throw error;
        });
        tailsMended.set(key, mended);
    }
    return mended;
};

// A document stored as JSON Lines, one entry per line, appended and never rewritten whole by this layer (usage.jsonl,
// activity.jsonl): its document is `boot: false`, since the boot step reads whole JSON files, and every read converts
// each line instead. Lines this build cannot read stay in the file for the build that wrote them.
export const openLedger = <D extends AnyDocument<"entries", false>>(spec: D, path: string): Ledger<DocumentUnit<D>> => {
    if (spec.directory || spec.granularity !== "entries") {
        throw layoutError(spec, "a ledger of lines");
    }
    return {
        read: async () => {
            const text = await readFile(path, "utf8").catch(undefinedIfMissing);
            return text === undefined ? [] : text.split("\n").flatMap((line) => (line === "" ? [] : (ledgerEntry(spec, line) ?? [])));
        },
        append: async (entry) => {
            await mkdir(dirname(path), { recursive: true });
            await tailMended(path);
            await appendFile(path, `${JSON.stringify(entry)}\n`);
        },
    };
};

// A file no document describes: a cache the daemon regrows (a provider's model catalog), read through a parse of its
// own and never converted. What a later build cannot read it simply refills.
export const cacheFile = <T>(path: string, options: Pick<JsonFileOptions<T>, "parse" | "fallback" | "mode">): JsonFile<T> =>
    jsonFile<T>(path, options);

// The owner's yes to what an agent can write, one pin per key, kept under the history root where no workspace write
// reaches: a document of `{ approved: { [key]: pin } }`.
export interface ApprovalLedger<P> {
    // An unreadable ledger approves nothing: its pins read as none, and `unreadable` says why.
    readonly read: () => Promise<{ readonly approved: Readonly<Record<string, P>>; readonly unreadable: boolean }>;
    // A change that returns the pins it was handed writes nothing.
    readonly update: (change: (approved: Readonly<Record<string, P>>) => Readonly<Record<string, P>>) => Promise<void>;
}

type PinOf<D> = DocumentValue<D> extends { readonly approved: Readonly<Record<string, infer P>> } ? P : never;

export const openApprovalLedger = <D extends AnyDocument<"object", false>>(spec: D, path: string): ApprovalLedger<PinOf<D>> => {
    type Pins = { readonly approved: Readonly<Record<string, PinOf<D>>> };
    // SAFETY: PinOf<D> is read off DocumentValue<D>'s own `approved` record, so the value is Pins by construction.
    const file = openDocument<D, Pins>(spec, path, { fallback: () => ({ approved: {} }), read: (value) => value as Pins });
    return {
        read: async () => {
            const ledger = await file.state();
            return ledger.unreadable ? { approved: {}, unreadable: true } : { approved: ledger.value.approved, unreadable: false };
        },
        update: async (change) => {
            await file.update((ledger) => {
                const approved = change(ledger.approved);
                return approved === ledger.approved ? ledger : { approved };
            });
        },
    };
};
