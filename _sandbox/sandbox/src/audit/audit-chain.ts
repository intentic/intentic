import { createHash } from "node:crypto";
import type { AuditRecord, AuditVerify } from "@intentic/sandbox-contract/schemas/audit";
import { z } from "zod";
import { parseJsonWith } from "@intentic/base/json";

// The hash chain behind the audit trail, kept free of files so it can be checked line by line by anyone holding an
// export. A record's hash covers its canonical JSON (keys sorted at every depth, `hash` itself left out), and that JSON
// includes `prevHash`, so changing, removing, inserting or reordering any record breaks every link after it.

// The `prevHash` of the first record a sandbox ever writes.
export const GENESIS_HASH = "0".repeat(64);

type Json = z.infer<ReturnType<typeof z.json>>;
type JsonObject = { readonly [key: string]: Json };

const byKey = ([a]: readonly [string, Json], [b]: readonly [string, Json]): number => (a < b ? -1 : a > b ? 1 : 0);

// JSON with object keys sorted at every depth and no whitespace: two writers that agree on the values agree on the
// bytes, whatever order the record's fields were built in.
export const canonicalJson = (value: Json): string => {
    if (Array.isArray(value)) {
        return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
    }
    if (value === null || !(value instanceof Object)) {
        return JSON.stringify(value);
    }
    const entries = Object.entries(value).toSorted(byKey);
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${canonicalJson(member)}`).join(",")}}`;
};

// The hash a record should carry: over every field it holds but `hash`.
export const recordHash = (record: JsonObject): string => {
    const { hash: _hash, ...body } = record;
    return createHash("sha256").update(canonicalJson(body)).digest("hex");
};

// A record as written: its body through JSON once, so the hash is over exactly what a reader will parse back (an
// `undefined` member is dropped here as it is on disk).
export const sealRecord = (body: Omit<AuditRecord, "hash">): AuditRecord => {
    const json = z.json().parse(JSON.parse(JSON.stringify(body)));
    // SAFETY: the body was an object, and a JSON round trip of an object is an object.
    return { ...body, hash: recordHash(json as JsonObject) };
};

// One segment's text as the verifier reads it: its name and its raw lines. A segment whose last line has no newline was
// cut short by a crash mid-write; that fragment is never a whole record, so it is reported as torn and skipped.
export interface SegmentText {
    readonly name: string;
    readonly text: string;
}

// What the verifier needs of a line: the two hashes, and the id and time to name it by. Every other field is hashed as
// it stands, whichever build wrote it.
const LinkSchema = z.looseObject({
    id: z.string().optional(),
    at: z.number().optional(),
    prevHash: z.string(),
    hash: z.string(),
});

const linkOf = (line: string): { readonly link: z.infer<typeof LinkSchema>; readonly json: JsonObject } | undefined => {
    // An unparseable line is exactly what the verifier reports as `unreadable`.
    const json = parseJsonWith(line, z.record(z.string(), z.json()));
    if (json === undefined) {
        return undefined;
    }
    const link = LinkSchema.safeParse(json);
    return link.success ? { link: link.data, json } : undefined;
};

type Broken = NonNullable<AuditVerify["broken"]>;

export interface ChainCheck {
    readonly checked: number;
    readonly broken: Broken | undefined;
    readonly torn: boolean;
    // The hash the next record must link to: the last whole record's, or `start` when there are none.
    readonly lastHash: string;
    readonly lastAt: number | undefined;
}

// A segment's whole lines. Only the newest segment's fragment is a torn write (`torn`); one in a closed segment was
// followed by later writes, so it stays a line and fails as unreadable.
const wholeLines = (text: string, newest: boolean) => {
    const lines = text.split("\n");
    const tail = lines.pop() ?? "";
    if (tail === "") {
        return { lines, torn: false };
    }
    return newest ? { lines, torn: true } : { lines: [...lines, tail], torn: false };
};

// Why a line does not check out against the hash before it, or undefined when it does.
const fault = (parsed: ReturnType<typeof linkOf>, previous: string): Broken["reason"] | undefined => {
    if (parsed === undefined) {
        return "unreadable";
    }
    if (recordHash(parsed.json) !== parsed.link.hash) {
        return "hash-mismatch";
    }
    return parsed.link.prevHash === previous ? undefined : "chain-break";
};

// Walks the segments oldest first, from `start` (the genesis hash, or the checkpoint pruning left), and stops at the
// first record that does not check out.
export const checkChain = (segments: readonly SegmentText[], start: string): ChainCheck => {
    let previous = start;
    let lastAt: number | undefined;
    let checked = 0;
    let torn = false;
    for (const [index, segment] of segments.entries()) {
        const whole = wholeLines(segment.text, index === segments.length - 1);
        torn = whole.torn;
        for (const [offset, line] of whole.lines.entries()) {
            const parsed = linkOf(line);
            const reason = fault(parsed, previous);
            if (reason !== undefined) {
                const broken: Broken = { segment: segment.name, line: offset + 1, reason, id: parsed?.link.id, at: parsed?.link.at };
                return { checked, broken, torn, lastHash: previous, lastAt };
            }
            // SAFETY: fault() answers undefined only for a parsed line.
            const link = (parsed as NonNullable<typeof parsed>).link;
            previous = link.hash;
            lastAt = link.at ?? lastAt;
            checked += 1;
        }
    }
    return { checked, broken: undefined, torn, lastHash: previous, lastAt };
};
