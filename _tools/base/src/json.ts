// JSON TEXT THAT MAY NOT BE JSON: a cache file, a stored setting, a line another process wrote. Only a SyntaxError means
// "not JSON"; anything else JSON.parse throws (a bug's TypeError from a text that is not a string) still arrives. No
// schema library here, as in `fetch-json.ts`: anything with zod's `safeParse` shape reads the value.
import type { JsonValue } from "./web/fetch-json.js";

export type { JsonValue } from "./web/fetch-json.js";

// The one method of a schema these helpers call; a zod schema, which takes any input, is one.
export interface SafeParser<T> {
    safeParse(value: JsonValue): { success: true; data: T } | { success: false };
}

// The parsed value, or `fallback` when the text is not JSON.
export const parseJsonOr = <F>(text: string, fallback: F): JsonValue | F => {
    try {
        const value: JsonValue = JSON.parse(text);
        return value;
    } catch (error) {
        if (error instanceof SyntaxError) {
            return fallback;
        }
        throw error;
    }
};

const NOT_JSON: unique symbol = Symbol("not JSON");

// The value the schema reads out of the text, or undefined when the text is not JSON or the schema refuses it.
export const parseJsonWith = <T>(text: string, schema: SafeParser<T>): T | undefined => {
    const value = parseJsonOr(text, NOT_JSON);
    if (value === NOT_JSON) {
        return undefined;
    }
    const result = schema.safeParse(value);
    return result.success ? result.data : undefined;
};
