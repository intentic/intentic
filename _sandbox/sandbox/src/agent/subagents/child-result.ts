import { z } from "zod";
import { errorMessage } from "@intentic/base/errors";

/* A SPAWNED CHILD'S RESULT, AS A VALUE ITS PARENT CAN BUILD ON. A child's report is prose, and a parent fanning out ten of
   them reads ten essays to pull one field from each. A parent may name a JSON Schema when it spawns one: the child is
   given a `result` tool whose input is that schema (subagent-wait.ts), so its runtime shows the model the exact shape and
   the tool refuses a value that does not match, said back to the model while it can still fix it. A child that ends
   without calling it is read for a JSON value at the end of its last message instead. `wait` hands the value over as
   `result`, or says why there is none as `resultError`. */

// A JSON value, as a result and as a schema are made of: the shape zod's own JSON schema parses, so a value read back from
// a file is one without a second check.
export const ResultValueSchema = z.json();
export type ResultValue = z.infer<typeof ResultValueSchema>;
export const ResultSchemaSchema = z.record(z.string(), ResultValueSchema);
export type ResultSchema = z.infer<typeof ResultSchemaSchema>;

// The keywords a result schema may use: enough to describe any record a parent reads fields from, and nothing that runs
// code of its own in the daemon (a `pattern` is a regular expression any agent could make catastrophic) or reaches past
// the document (`$ref`).
const KEYWORDS: ReadonlySet<string> = new Set([
    "type",
    "properties",
    "required",
    "items",
    "enum",
    "const",
    "description",
    "title",
    "minimum",
    "maximum",
    "exclusiveMinimum",
    "exclusiveMaximum",
    "minLength",
    "maxLength",
    "minItems",
    "maxItems",
    "additionalProperties",
    "default",
]);

// How large a schema may be, written out, and how deep it may nest: a record a parent reads, not a document format.
const MAX_SCHEMA_CHARS = 16_000;
const MAX_DEPTH = 10;
// How large a result may be, written out: past this it is a report, which is what the report is for.
const MAX_RESULT_CHARS = 60_000;

const isObject = (value: ResultValue | undefined): value is ResultSchema =>
    typeof value === "object" && value !== null && !Array.isArray(value);

// What is wrong with one keyword of a schema at `path`, or with the schemas under it; undefined when nothing is.
const strayIn = (key: string, value: ResultValue, path: string, depth: number): string | undefined => {
    if (!KEYWORDS.has(key)) {
        return `${path}.${key}: not a keyword a result schema may use (it may use ${[...KEYWORDS].join(", ")})`;
    }
    if (key === "items") {
        return strayKeyword(value, `${path}.items`, depth + 1);
    }
    if (key === "additionalProperties" && value !== true && value !== false) {
        return `${path}.additionalProperties: true or false`;
    }
    if (key !== "properties") {
        return undefined;
    }
    if (!isObject(value)) {
        return `${path}.properties: an object of schemas`;
    }
    return Object.entries(value)
        .map(([name, inner]) => strayKeyword(inner, `${path}.properties.${name}`, depth + 1))
        .find((stray) => stray !== undefined);
};

// The first keyword outside the subset, by its path, or undefined when every one is in it.
function strayKeyword(schema: ResultValue, path: string, depth: number): string | undefined {
    if (depth > MAX_DEPTH) {
        return `${path}: nested deeper than ${MAX_DEPTH} levels`;
    }
    if (!isObject(schema)) {
        return `${path}: a schema is an object`;
    }
    return Object.entries(schema)
        .map(([key, value]) => strayIn(key, value, path, depth))
        .find((stray) => stray !== undefined);
}

// Built once per schema text: the same schema reaches the spawn, every turn's tool mount and every report.
const BUILT = new Map<string, z.ZodType>();
const BUILT_KEPT = 200;

const built = (schema: ResultSchema): z.ZodType => {
    const key = JSON.stringify(schema);
    const known = BUILT.get(key);
    if (known !== undefined) {
        return known;
    }
    // SAFETY: the subset check above ran first; zod reads the JSON Schema it builds from as a plain object.
    const made = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0]);
    if (BUILT.size >= BUILT_KEPT) {
        BUILT.clear();
    }
    BUILT.set(key, made);
    return made;
};

/** Whether a schema a parent named can be a result's: undefined when it can, else why not, in words for the parent. */
export const resultSchemaFault = (schema: ResultValue): string | undefined => {
    const text = JSON.stringify(schema);
    if (text.length > MAX_SCHEMA_CHARS) {
        return `The result schema is ${text.length} characters written out; keep it under ${MAX_SCHEMA_CHARS}.`;
    }
    const stray = strayKeyword(schema, "schema", 0);
    if (stray !== undefined) {
        return `The result schema cannot be used: ${stray}.`;
    }
    if (!isObject(schema)) {
        return "The result schema must be a JSON Schema object.";
    }
    try {
        // The child's tool states this schema to its model, so it has to survive the trip back out.
        z.toJSONSchema(z.object({ value: built(schema) }));
        return undefined;
    } catch (error) {
        return `The result schema cannot be used: ${errorMessage(error)}.`;
    }
};

/** The validator a child's `result` tool takes as its `value`; the schema passed resultSchemaFault at the spawn. */
export const resultValidator = (schema: ResultSchema): z.ZodType => built(schema);

/** What a value is checked to: the value, or every issue with it in one line each. */
export const checkResult = (schema: ResultSchema, value: ResultValue): { readonly value: ResultValue } | { readonly error: string } => {
    if (JSON.stringify(value).length > MAX_RESULT_CHARS) {
        return { error: `The result is over ${MAX_RESULT_CHARS} characters written out: return the record, and leave prose for the report.` };
    }
    const parsed = built(schema).safeParse(value);
    if (parsed.success) {
        return { value };
    }
    return { error: parsed.error.issues.map((issue) => `${issue.path.length === 0 ? "value" : issue.path.join(".")}: ${issue.message}`).join("; ") };
};

// A fenced JSON block, the last of which a child that never called the tool is read for.
const FENCED = /```(?:json)?[ \t]*\n([\s\S]*?)\n?```/gu;

const parsedJson = (text: string): ResultValue | undefined => {
    try {
        // SAFETY: JSON.parse yields exactly the JSON value grammar ResultValue spells.
        return JSON.parse(text) as ResultValue;
    } catch {
        // allow(silent-catch): text that is not JSON is the ordinary case for a report, and means no value in it.
        return undefined;
    }
};

/** The JSON value at the end of a child's closing message: its last fenced block, else the whole message. */
export const resultInText = (closing: string): ResultValue | undefined => {
    const blocks = [...closing.matchAll(FENCED)];
    const last = blocks.at(-1)?.[1];
    return last !== undefined ? parsedJson(last.trim()) : parsedJson(closing.trim());
};

/**
 * A settled turn's result: the value its tool took, else one read off its closing message, else why there is none.
 * Undefined for a child spawned with no schema.
 */
export const turnResult = (
    schema: ResultSchema | undefined,
    submitted: { readonly value: ResultValue } | undefined,
    closing: string,
): { readonly value: ResultValue } | { readonly error: string } | undefined => {
    if (schema === undefined) {
        return undefined;
    }
    if (submitted !== undefined) {
        return submitted;
    }
    const found = resultInText(closing);
    if (found === undefined) {
        return { error: "It ended without calling its result tool, and its last message holds no JSON value." };
    }
    const checked = checkResult(schema, found);
    return "value" in checked ? checked : { error: `It ended without calling its result tool, and the JSON at the end of its last message does not match the schema: ${checked.error}` };
};

/** What a child spawned with a schema is told about it, after its task. */
export const resultContract = (schema: ResultSchema): string =>
    [
        "---",
        "Your parent needs a structured result from this task, not only a report. When the work is done, call the `result` tool (on the `subagents` server) exactly once, with `value` matching this JSON Schema:",
        "```json",
        JSON.stringify(schema, undefined, 2),
        "```",
        "The tool refuses a value that does not match and says why: fix it and call again. Then end your turn with a short report. If you cannot reach that tool, end your final message with the value as a fenced ```json block instead.",
    ].join("\n");
