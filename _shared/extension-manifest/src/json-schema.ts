import { z } from "zod";
import { ExtensionManifestSchema } from "./manifest.js";

// The authoring schema an editor reads for `intentic-extension.json`: the same points, emitted as JSON Schema, with
// each contribution point's description (contribution-point.ts) arriving as hover text. Strict here
// (`additionalProperties: false` throughout) though the runtime parse is lenient, since an unknown key here is a typo,
// not a newer host's addition.

// Where the published copy answers, so `$schema` in a manifest resolves for an author who has installed nothing.
export const MANIFEST_SCHEMA_URL = "https://intentic.dev/intentic-extension.schema.json";

// Sets `additionalProperties: false` on every object node so an unknown key is flagged where it is typed. Skips a node
// that already declares it or is a `z.record` (any key valid, e.g. a cli capability's `env`).
const closeToUnknownKeys = (node: unknown): void => {
    if (Array.isArray(node)) {
        for (const item of node) {
            closeToUnknownKeys(item);
        }
        return;
    }
    if (typeof node !== "object" || node === null) {
        return;
    }
    const schema = node as Record<string, unknown>;
    if (schema["type"] === "object" && schema["properties"] !== undefined && schema["additionalProperties"] === undefined) {
        schema["additionalProperties"] = false;
    }
    for (const value of Object.values(schema)) {
        closeToUnknownKeys(value);
    }
};

// The manifest schema as JSON Schema. `io: "input"` describes what an author writes, before any refinement or default.
export const manifestJsonSchema = (): Record<string, unknown> => {
    const schema = z.toJSONSchema(ExtensionManifestSchema, { unrepresentable: "any", io: "input" }) as Record<string, unknown>;
    closeToUnknownKeys(schema);
    return {
        ...schema,
        $id: MANIFEST_SCHEMA_URL,
        title: "intentic extension manifest",
        description: "What an intentic extension declares: who it is, which host it needs, what code it ships, and what it contributes.",
    };
};

// The committed file's exact bytes (four-space indent, trailing newline), so the generator and the check that guards it
// can't disagree about formatting.
export const serializeManifestJsonSchema = (schema: Record<string, unknown>): string => `${JSON.stringify(schema, undefined, 4)}\n`;
