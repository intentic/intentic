import type { Ref, SecretRef } from "./types.js";

export const makeRef = <T = unknown>(resourceId: string, output?: string): Ref<T> =>
    Object.freeze(output === undefined ? { kind: "ref", resourceId } : { kind: "ref", resourceId, output }) as Ref<T>;

// Canonical dotted-ref string grammar (`id` or `id.output`). The serializer emits it into {$ref};
// the engine builds the same key to store and look up resolved outputs.
export const refKey = (resourceId: string, output?: string): string => (output === undefined ? resourceId : `${resourceId}.${output}`);

export const isRef = (value: unknown): value is Ref<unknown> =>
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "ref";

export const isSecret = (value: unknown): value is SecretRef =>
    typeof value === "object" && value !== null && (value as { kind?: unknown }).kind === "secret";
