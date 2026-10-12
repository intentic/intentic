import { isJsonObject, type JsonObject } from "../store/evolution/conversions.js";

// How a log line is cut down before it reaches a model's context: a stack it did not ask for, the thirty-entry code
// table every DOMException serializes, a ten-kilobyte string, each cost more than the line's actual signal, and a
// sixty-line answer once ran to 83 KB. Also how repeats are recognized, so one loop's hundred lines read as one row.

const STRING_CHARS = 400;
const ARRAY_ITEMS = 8;
const DEPTH = 4;

// What an error says about itself; the rest (Node's own code tables, enumerable internals) is noise in a diagnosis.
const ERROR_KEYS = ["type", "name", "message", "code", "errno", "syscall", "path", "status", "statusCode", "signal"] as const;

// pino's err serializer, or anything shaped like it: an object carrying a string stack.
const isError = (value: JsonObject): value is JsonObject & { readonly stack: string } => typeof value["stack"] === "string" && "message" in value;

const compactError = (error: JsonObject, stacks: boolean, depth: number): JsonObject => {
    const kept: JsonObject = {};
    for (const key of ERROR_KEYS) {
        if (error[key] !== undefined && !(key === "name" && error["name"] === error["type"])) {
            kept[key] = compactValue(error[key], stacks, depth + 1);
        }
    }
    if (stacks && isError(error)) {
        kept["stack"] = error.stack;
    }
    if (isJsonObject(error["cause"])) {
        kept["cause"] = compactError(error["cause"], stacks, depth + 1);
    }
    return kept;
};

function compactValue(value: unknown, stacks: boolean, depth: number): unknown {
    if (typeof value === "string") {
        return value.length > STRING_CHARS ? `${value.slice(0, STRING_CHARS)}…(+${value.length - STRING_CHARS} chars)` : value;
    }
    if (Array.isArray(value)) {
        if (depth >= DEPTH) {
            return `[${value.length} items]`;
        }
        const shown = value.slice(0, ARRAY_ITEMS).map((item) => compactValue(item, stacks, depth + 1));
        return value.length > ARRAY_ITEMS ? [...shown, `…+${value.length - ARRAY_ITEMS} more`] : shown;
    }
    if (!isJsonObject(value)) {
        return value;
    }
    if (isError(value)) {
        return compactError(value, stacks, depth);
    }
    if (depth >= DEPTH) {
        return `{${Object.keys(value).length} keys}`;
    }
    // A browser report carries its stack as a plain field beside its own (report.stack), not as a serialized error.
    const entries = Object.entries(value).filter(([key, inner]) => stacks || key !== "stack" || typeof inner !== "string");
    return Object.fromEntries(entries.map(([key, inner]) => [key, compactValue(inner, stacks, depth + 1)]));
}

/** A log line as a model should read it: errors cut to what they say, long strings and lists trimmed, stacks only when asked. */
export const compactRecord = (record: JsonObject, stacks: boolean): JsonObject => {
    // The pid is the same on every line of a run; the boot it names is in `restarts`.
    const { pid: _pid, ...rest } = record;
    return Object.fromEntries(Object.entries(rest).map(([key, value]) => [key, compactValue(value, stacks, 1)]));
};

/**
 * The message with what varies between repeats of it taken out (ids, numbers, quoted names), so one loop's lines share a
 * key. This daemon puts variable facts in fields rather than in the message, so the message is nearly always the key.
 */
export const templateOf = (record: JsonObject): string => {
    const { event, message } = record;
    return `${event === undefined ? "" : `${String(event)}: `}${message === undefined ? "" : String(message)}`
        .slice(0, 200)
        .replaceAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
        .replaceAll(/`[^`]*`|"[^"]*"/g, "<name>")
        .replaceAll(/\b[0-9a-f]{7,}\b/gi, "<hex>")
        .replaceAll(/\d+(?:\.\d+)?/g, "<n>");
};

/** The value at fraction `q` of an ascending list (nearest rank). */
export const quantile = (ascending: readonly number[], q: number): number =>
    ascending[Math.min(ascending.length - 1, Math.max(0, Math.ceil(q * ascending.length) - 1))] ?? 0;

/** Lines joined until the next would pass `maxChars`; answers what fit and how many did not. */
export const capLines = (lines: readonly string[], maxChars: number) => {
    let total = 0;
    const kept: string[] = [];
    for (const line of lines) {
        total += line.length + 1;
        if (total > maxChars && kept.length > 0) {
            break;
        }
        kept.push(line);
    }
    return { kept, dropped: lines.length - kept.length };
};
