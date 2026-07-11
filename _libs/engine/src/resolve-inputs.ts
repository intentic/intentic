import type { SecretSource, SerializedValue } from "@intentic/graph";
import type { OutputStore } from "./store.js";

// Inputs in the compiled graph are SERIALIZED: $ref/$secret are plain objects, NOT the protocol's
// kind:"ref"/kind:"secret" form. So we detect them structurally and must NOT use protocol isRef/isSecret.
const isSecretNode = (value: object): value is { readonly $secret: { readonly source: SecretSource; readonly key: string } } => "$secret" in value;
const isRefNode = (value: object): value is { readonly $ref: string } => "$ref" in value;

export const resolveInputs = (
    inputs: Readonly<Record<string, SerializedValue>>,
    store: OutputStore,
    env: Readonly<Record<string, string | undefined>>,
    options: { readonly lenient: boolean },
): Record<string, unknown> => {
    const walk = (value: SerializedValue): unknown => {
        if (Array.isArray(value)) {
            return value.map(walk);
        }
        if (typeof value === "object" && value !== null) {
            if (isSecretNode(value)) {
                const secret = env[value.$secret.key];
                if (secret === undefined) {
                    throw new Error(`missing secret env var "${value.$secret.key}"`);
                }
                return secret;
            }
            if (isRefNode(value)) {
                // One lookup serves both: bare "host" -> "host" (seeded), output "host-git.url" -> value.
                return store.get(value.$ref, { lenient: options.lenient });
            }
            const result: Record<string, unknown> = {};
            for (const [key, entry] of Object.entries(value)) {
                result[key] = walk(entry);
            }
            return result;
        }
        return value;
    };

    const resolved: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(inputs)) {
        resolved[key] = walk(value);
    }
    return resolved;
};
