/* ZOD 4 → JSON SCHEMA, for oRPC's OpenAPI generator.
 *
 * oRPC ships no converter of its own: `OpenAPIGenerator` takes a list of them and asks each whether it
 * recognizes a schema. There is an official `@orpc/zod` for this, and it is deliberately not a dependency
 * here, because the whole of what it would do for THIS contract is the twelve lines below. Zod 4 emits JSON
 * Schema natively (`z.toJSONSchema`), the contract uses only constructs that survive that trip (string,
 * number, boolean, object, array, enum, literal, record, union, discriminatedUnion, tuple, stringbool,
 * unknown: see the survey in the package README), and contract-lock.ts already makes exactly this call for
 * exactly this reason. A second dependency that wraps a built-in is a second thing to keep in step.
 *
 * TWO DIRECTIONS, NOT ONE, and this is the part a hand-rolled converter usually gets wrong. `z.stringbool()`
 * parses the string "1" into the boolean `true`, so its request shape is `string` and its response shape is
 * `boolean`. Passing the generator's own `strategy` through as zod's `io` is what keeps a request body
 * documented as what you SEND and a response as what you GET, rather than one shape claimed for both. The
 * same distinction covers every `.default()` in the contract: optional going in, always present coming out.
 */

import type { AnySchema } from "@orpc/contract";
import type { ConditionalSchemaConverter } from "@orpc/openapi";
import type { JSONSchema } from "json-schema-typed/draft-2020-12";
import { z } from "zod";

/* A schema is zod's if it says so through the Standard Schema surface. Structural rather than `instanceof`:
 * this package and the contract resolve zod through their own dependency edges, and two copies of the same
 * version still fail an identity check. */
const isZod = (schema: AnySchema | undefined): schema is z.ZodType => schema !== undefined && schema["~standard"].vendor === "zod";

/* WHETHER THE VALUE HAS TO BE THERE, which is a different question from what shape it has. oRPC asks for it
 * separately because it decides whether a request body is `required` and whether a field lands in an object's
 * `required` list. `optin` is zod's own answer and covers both spellings that make a value skippable:
 * `.optional()` and `.default()`. Asking `def.type === "optional"` would miss the second. */
const isOptionalIn = (schema: z.ZodType): boolean => schema._zod.optin === "optional";

export const zodConverter: ConditionalSchemaConverter = {
    condition: (schema) => isZod(schema),
    convert: (schema, options) => {
        if (!isZod(schema)) {
            // Unreachable through the generator, which consults `condition` first. Thrown rather than
            // defaulted so a future caller that skips the check hears about it.
            throw new Error(`zodConverter reached a schema it does not recognize: ${String(schema)}`);
        }
        const json = z.toJSONSchema(schema, {
            io: options.strategy,
            /* A construct JSON Schema cannot express becomes `{}` instead of throwing. Nothing in the
             * contract needs this today, and the day something does, one field documented as "any shape" is a
             * better outcome than a build that cannot describe the other 254 operations. */
            unrepresentable: "any",
        });
        /* The dialect banner is identical on every one of these and the document already declares its own at
         * the top level, so ~4,500 copies of it are pure weight. contract-lock.ts drops it for the same
         * reason. */
        delete json.$schema;
        /* THE ONE CAST IN THIS PACKAGE, and it is a disagreement between two libraries rather than a shortcut.
         * Zod and json-schema-typed both describe JSON Schema draft 2020-12, and they disagree about two
         * keywords: `$vocabulary` maps to booleans in the specification and json-schema-typed declares it as
         * strings, and json-schema-typed threads a generic through `$defs` that zod's plain records do not
         * carry. Neither disagreement can be reached by a runtime value the contract produces — it is objects,
         * strings, numbers and enums, with no `$vocabulary` anywhere — so the shapes agree and only the
         * declarations do not.
         *
         * Through `unknown` rather than direct, because those two differences are enough for TypeScript to
         * refuse the pair as non-overlapping. Widening first is the honest spelling of "these are the same
         * document described twice", and it keeps the assertion at one line that says why. */
        return [!isOptionalIn(schema), json as unknown as JSONSchema];
    },
};
