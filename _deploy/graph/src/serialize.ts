import { isRef, isSecret, refKey } from "./ref.js";
import type { SerializedValue } from "./types.js";

export const serializeValue = (value: unknown): SerializedValue => {
    if (isRef(value)) {
        return { $ref: refKey(value.resourceId, value.output) };
    }
    if (isSecret(value)) {
        return { $secret: { source: value.source, key: value.key } };
    }
    if (Array.isArray(value)) {
        return value.map(serializeValue);
    }
    if (typeof value === "object" && value !== null) {
        const result: Record<string, SerializedValue> = {};
        for (const [key, entry] of Object.entries(value)) {
            result[key] = serializeValue(entry);
        }
        return result;
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        return value;
    }
    throw new Error(`cannot serialize value of type ${typeof value}`);
};

export const collectRefs = (value: unknown): string[] => {
    if (isRef(value)) {
        return [value.resourceId];
    }
    if (isSecret(value)) {
        return [];
    }
    if (Array.isArray(value)) {
        return value.flatMap(collectRefs);
    }
    if (typeof value === "object" && value !== null) {
        return Object.values(value).flatMap(collectRefs);
    }
    return [];
};
