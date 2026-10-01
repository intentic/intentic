import type { RestoreText, ShieldBinary } from "../shield-types.js";

// A request or response body as JSON.parse leaves it. The walkers read it only through the guards below and build new
// values instead of editing it, so the gateway still holds the body exactly as the harness sent it.
export type Json = string | number | boolean | null | readonly Json[] | JsonObject;
export interface JsonObject {
    readonly [key: string]: Json;
}

export type MaskText = (text: string) => Promise<string>;

export const isRecord = (value: Json | undefined): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);
export const isList = (value: Json | undefined): value is readonly Json[] => Array.isArray(value);
export const isText = (value: Json | undefined): value is string => typeof value === "string";
export const isCount = (value: Json | undefined): value is number => typeof value === "number" && Number.isInteger(value);

// Checks a parsed body really is JSON before the walkers lean on that type. JSON.parse output always passes; anything
// else (a Date, a Map, undefined) is a caller bug the shield refuses rather than half-walks.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- this guard is the boundary that turns a parsed body into Json.
const isJson = (value: unknown): value is Json => {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return true;
    }
    if (typeof value === "number") {
        return Number.isFinite(value);
    }
    if (Array.isArray(value)) {
        return value.every((item) => isJson(item));
    }
    if (typeof value !== "object") {
        return false;
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    return (prototype === Object.prototype || prototype === null) && Object.values(value).every((item) => isJson(item));
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- the gateway's parsed HTTP body is this module's I/O boundary.
export const toJson = (body: unknown): Json => {
    if (!isJson(body)) {
        throw new TypeError("privacy gateway: a body must be a parsed JSON value");
    }
    return body;
};

export const typeOf = (value: Json | undefined): Json | undefined => (isRecord(value) ? value["type"] : undefined);

// A copy of `object` with `key` set, or `object` itself when the value is already there: unchanged parts keep their
// identity, which is how a stream knows it may forward an event byte for byte.
export const patch = (object: JsonObject, key: string, value: Json | undefined): JsonObject =>
    value === undefined || object[key] === value ? object : { ...object, [key]: value };

// `list` mapped, or `list` itself when no item changed.
export const mapSame = (list: readonly Json[], change: (item: Json) => Json): readonly Json[] => {
    const next = list.map(change);
    return next.every((item, index) => item === list[index]) ? list : next;
};

export const mapAll = async (list: readonly Json[], change: (item: Json) => Promise<Json>): Promise<readonly Json[]> => Promise.all(list.map(change));

// Empty strings are skipped: there is nothing in them to mask, and the masker may be a model call.
export const maskText = async (text: string, mask: MaskText): Promise<string> => (text === "" ? text : mask(text));

export const maskField = async (object: JsonObject, key: string, mask: MaskText): Promise<JsonObject> => {
    const value = object[key];
    return isText(value) ? patch(object, key, await maskText(value, mask)) : object;
};

export const restoreField = (object: JsonObject, key: string, restore: RestoreText): JsonObject => {
    const value = object[key];
    return isText(value) ? patch(object, key, restore(value)) : object;
};

// Every string VALUE masked, at any depth. Keys are structure the harness's tools defined, not content.
export const maskStrings = async (value: Json, mask: MaskText): Promise<Json> => {
    if (isText(value)) {
        return maskText(value, mask);
    }
    if (isList(value)) {
        return mapAll(value, async (item) => maskStrings(item, mask));
    }
    if (isRecord(value)) {
        const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await maskStrings(item, mask)] as const));
        return Object.fromEntries(entries);
    }
    return value;
};

// Every string VALUE restored, at any depth; keys stay as written, mirroring what the request side masked.
export const restoreStrings = (value: Json, restore: RestoreText): Json => {
    if (isText(value)) {
        return restore(value);
    }
    if (isList(value)) {
        return mapSame(value, (item) => restoreStrings(item, restore));
    }
    if (isRecord(value)) {
        let changed = false;
        const entries = Object.entries(value).map(([key, item]) => {
            const next = restoreStrings(item, restore);
            changed ||= next !== item;
            return [key, next] as const;
        });
        return changed ? Object.fromEntries(entries) : value;
    }
    return value;
};

// A string that may or may not be JSON; undefined when it is not.
export const parseJson = (text: string): Json | undefined => {
    try {
        return toJson(JSON.parse(text));
    } catch {
        // allow(silent-catch): text that is not JSON is an answer here (forward it as it came), not a failure.
        return undefined;
    }
};

// `data:<media type>;base64,<data>`, the form both OpenAI APIs take inline images and files in. Anything else is a
// reference the shield cannot look inside, named by its URL. Parsed by hand: the payload can be megabytes long.
export const binaryOfUrl = (url: string): ShieldBinary => {
    const comma = url.indexOf(",");
    if (!url.startsWith("data:") || comma < 0) {
        return { mediaType: "url", data: url };
    }
    const [mediaType, ...parameters] = url.slice("data:".length, comma).split(";");
    return parameters.includes("base64")
        ? { mediaType: mediaType === undefined || mediaType === "" ? "application/octet-stream" : mediaType, data: url.slice(comma + 1) }
        : { mediaType: "url", data: url };
};

// The inverse of binaryOfUrl for an inline image or file.
export const dataUrl = (binary: ShieldBinary): string => `data:${binary.mediaType};base64,${binary.data}`;

// The note joins instructions as a paragraph of its own; instructions that are only whitespace become the note.
export const withNote = (instructions: string, note: string): string => (instructions.trim() === "" ? note : `${instructions}\n\n${note}`);
