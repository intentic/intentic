// Converts Zod4 schemas to JSON Schema for oRPC's OpenAPI generator, via z.toJSONSchema rather than @orpc/zod, since
// the contract only uses constructs that survive that trip. Passes the generator's `strategy` through as zod's `io`,
// since `.stringbool()` and `.default()` give a request and a response different shapes.

import type { AnySchema } from "@orpc/contract";
import type { ConditionalSchemaConverter } from "@orpc/openapi";
import type { JSONSchema } from "json-schema-typed/draft-2020-12";
import { z } from "zod";

// Whether a schema is zod's, via the Standard Schema surface rather than instanceof: two copies of the same zod version
// fail an identity check.
const isZod = (schema: AnySchema | undefined): schema is z.ZodType => schema !== undefined && schema["~standard"].vendor === "zod";

// Whether a value may be omitted, covering both `.optional()` and `.default()` (zod's own `optin` flag); checking
// `def.type === "optional"` alone would miss the second.
const isOptionalIn = (schema: z.ZodType): boolean => schema._zod.optin === "optional";

export const zodConverter: ConditionalSchemaConverter = {
    condition: (schema) => isZod(schema),
    convert: (schema, options) => {
        if (!isZod(schema)) {
            // Unreachable via the generator, which checks `condition` first; thrown if a caller skips that.
            throw new Error(`zodConverter reached a schema it does not recognize: ${String(schema)}`);
        }
        const json = z.toJSONSchema(schema, {
            io: options.strategy,
            // An unrepresentable construct becomes `{}` rather than throwing; nothing here needs this yet.
            unrepresentable: "any",
        });
        // Every schema's own $schema banner duplicates the document's top-level one: dead weight, repeated.
        delete json.$schema;
        // Zod and json-schema-typed disagree on $vocabulary's type and $defs's genericity; cast via unknown.
        return [!isOptionalIn(schema), json as unknown as JSONSchema];
    },
};
