import { z } from "zod";
import { ExtensionManifestSchema } from "./manifest.js";

/* THE AUTHORING SCHEMA — what an editor reads to help someone write `intentic-extension.json`.
 *
 * A manifest was previously written by copying another extension's and guessing. Nothing told the author what a
 * field meant, because every explanation lived in a `//` comment in this package; and nothing told them when
 * they got one wrong, because zod STRIPS unknown keys at every level rather than refusing them. A misspelt
 * `viewers` was not an error — it was a viewer that never appeared, discovered at install, with the manifest
 * parsing perfectly.
 *
 * So: the same points, emitted as JSON Schema, with the descriptions that ride each one (contribution-point.ts)
 * arriving as hover text. Editors resolve `$schema` and give completion, documentation and a red squiggle on a
 * key nothing declares.
 *
 * STRICT HERE, LENIENT AT RUNTIME, and the asymmetry is the point. Authoring is where an unknown key is a typo
 * and should be shouted about. Runtime is where an unknown key is a manifest written for a NEWER host, which an
 * older daemon must go on installing with the point it doesn't understand ignored — refusing it outright would
 * make every addition to this list a breaking change. */

// Where the published copy answers, so `$schema` in a manifest resolves for an author who has installed nothing.
export const MANIFEST_SCHEMA_URL = "https://intentic.dev/intentic-extension.schema.json";

/* `additionalProperties: false` on every object node, so a key nothing declares is flagged where it is typed.
 *
 * Skips a node that already carries `additionalProperties` — that is a `z.record`, whose whole shape is "any key,
 * this value" (a cli capability's `env`), and pinning it closed would reject every entry it exists to accept. */
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

/* The manifest schema as JSON Schema. `io: "input"` because this describes what an author WRITES — the shape
 * going in, before any refinement or default has been applied to it. */
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

// The committed file's exact bytes, so the generator and the check that guards it cannot disagree about
// formatting — four spaces and a trailing newline, the repo's shape for a committed generated document.
export const serializeManifestJsonSchema = (schema: Record<string, unknown>): string => `${JSON.stringify(schema, undefined, 4)}\n`;
