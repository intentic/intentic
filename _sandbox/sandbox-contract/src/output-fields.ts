import { z } from "zod";

/* A DECLARED OUTPUT SHAPE, the answer to "what does this session produce?", written once and used three ways.
 *
 * An agentic session's natural output is prose, and prose is unusable as an input to the next session: a step
 * that must hand "the three files worth changing" to the step after it cannot hand over a paragraph that
 * mentions them. So a session that feeds another one declares its shape here, and that one declaration
 * becomes: the sentence in the prompt that tells the model what to write, the validator that decides whether
 * it complied, and the table the run view renders. Written once because the three drift apart the moment they
 * are written twice, a prompt asking for `files` and a validator wanting `paths` fails on every iteration and
 * says nothing useful about why.
 *
 * WHY A FIELD LIST AND NOT JSON SCHEMA. JSON Schema is strictly more expressive and completely unauthorable in
 * a form: nobody designing a workflow is going to hand-write `{"type":"object","properties":{...}}`, and a UI
 * that generates it becomes a schema editor, which is a product of its own. Four scalar types plus a string
 * list covers what one session actually hands another, a verdict, a count, a list of paths, a summary, and
 * anything past that is better carried as a file the next step reads.
 *
 * `description` IS REQUIRED, and that is the field that decides whether this works at all. `{name: "risk"}`
 * gets you the model's guess at what risk means; `{name: "risk", description: "high | medium | low, how
 * likely this change is to break something at runtime"}` gets you the answer to the question you asked.
 */

// Restricted to a JS-identifier-ish shape: these become object keys the prompt spells out literally, and a
// name with a quote or a newline in it produces a prompt that cannot be complied with.
const FIELD_NAME = /^[a-zA-Z_][a-zA-Z0-9_]{0,39}$/;

export const OutputFieldSchema = z.object({
    name: z.string().regex(FIELD_NAME),
    type: z.enum(["string", "number", "boolean", "string[]"]),
    // What the field means, in the words the model is given. Not optional, see the note above.
    description: z.string().min(1),
    // An absent optional field validates; an absent required one does not, and the iteration is told which.
    required: z.boolean(),
});
export type OutputField = z.infer<typeof OutputFieldSchema>;

// How many fields one output may declare. A shape past this is not a handoff, it is a report, and a report is
// what the prose half of the document is for.
export const OUTPUT_FIELDS_MAX = 16;

/* Repeated names make the declaration internally contradictory: object validation can only keep one rule for
 * a key, while a consumer looking the field up sees whichever copy it happens to ask for first. Reject them at
 * the declaration boundary, before either interpretation gets a chance to exist. Exported because graph-level
 * validation uses the same fact to explain the fault in the designer before a save is attempted. */
export const duplicateOutputFieldNames = (fields: readonly Pick<OutputField, "name">[]): string[] => {
    const seen = new Set<string>();
    const repeated = new Set<string>();
    for (const field of fields) {
        if (seen.has(field.name)) {
            repeated.add(field.name);
        }
        seen.add(field.name);
    }
    return [...repeated];
};

export const OutputFieldsSchema = z
    .array(OutputFieldSchema)
    .min(1)
    .max(OUTPUT_FIELDS_MAX)
    .superRefine((fields, context) => {
        for (const name of duplicateOutputFieldNames(fields)) {
            context.addIssue({ code: "custom", message: `Output field names must be unique; "${name}" is repeated.` });
        }
    });

const validatorFor = (field: OutputField): z.ZodType => {
    if (field.type === "number") {
        return z.number();
    }
    if (field.type === "boolean") {
        return z.boolean();
    }
    if (field.type === "string[]") {
        return z.array(z.string());
    }
    return z.string();
};

/* The declared shape as a validator. Unknown keys are ALLOWED THROUGH: a model that answered everything asked
 * of it and then added a `notes` key has complied, and failing it there would burn an iteration teaching it to
 * write less. What is enforced is that every required field is present and every present field has the
 * declared type, the two things the reader downstream is entitled to assume.
 */
export const fieldsValidator = (fields: readonly OutputField[]): z.ZodType =>
    z.looseObject(Object.fromEntries(fields.map((field) => [field.name, field.required ? validatorFor(field) : validatorFor(field).optional()])));

// A worked example of the declared shape, so the prompt can show rather than describe. Values are the field's
// own description, a model copying the example's structure has the description in front of it as it fills each
// slot, which is where it is needed rather than in a legend three lines up.
export const fieldsExample = (fields: readonly OutputField[]): Record<string, unknown> =>
    Object.fromEntries(
        fields.map((field) => {
            const hint = `${field.description}${field.required ? "" : " (optional — omit if it does not apply)"}`;
            if (field.type === "number") {
                return [field.name, 0];
            }
            if (field.type === "boolean") {
                return [field.name, false];
            }
            if (field.type === "string[]") {
                return [field.name, [hint]];
            }
            return [field.name, hint];
        }),
    );

// One line per field, for surfaces with no room to render an example: "risk (string, required), how likely …".
export const describeFields = (fields: readonly OutputField[]): string =>
    fields.map((field) => `- \`${field.name}\` (${field.type}${field.required ? ", required" : ", optional"}) — ${field.description}`).join(`\n`);
