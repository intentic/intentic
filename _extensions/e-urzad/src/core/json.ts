import { z } from "zod";

// JSON as JSON: what an office API answers beyond the fields a client names, kept verbatim for the agent and the
// records, and what a payload file the agent wrote holds before it is sent.

export type JsonValue = string | number | boolean | null | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() => z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(JsonValueSchema), z.record(z.string(), JsonValueSchema)]));

export const JsonObjectSchema: z.ZodType<JsonObject> = z.record(z.string(), JsonValueSchema);

// Any serialisable value as plain JSON (what JSON.stringify would write), for answers that pass through untouched.
export const toJson = <T>(value: T): JsonValue => JsonValueSchema.parse(JSON.parse(JSON.stringify(value ?? null)));

export const parseJsonObject = (text: string, what: string): JsonObject => {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        throw new Error(`${what} is not JSON`);
    }
    const parsed = JsonObjectSchema.safeParse(raw);
    if (!parsed.success) {
        throw new Error(`${what} must be a JSON object`);
    }
    return parsed.data;
};
