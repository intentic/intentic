import { z } from "zod";

// A declared output shape, written once, used three ways: the prompt sentence, the validator, and the table the run
// view renders. Four scalar types plus a string list, not JSON Schema, since nobody hand-writes a schema in a form.
// `description` is required: it's the difference between a model guessing and answering.

// Restricted to a JS-identifier shape: names become literal object keys the prompt spells out.
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

// How many fields one output may declare; past this it is a report, not a handoff, and prose is for that.
export const OUTPUT_FIELDS_MAX = 16;

// Repeated names make a declaration self-contradictory: object validation keeps one rule per key, and a consumer sees
// whichever copy it asks for first. Rejected at the boundary; exported so graph-level validation reuses the same fault.
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

// The declared shape as a validator. Unknown keys are allowed through — a model that answered everything and added a
// `notes` key has complied — but every required field must be present and every present field must match its type.
export const fieldsValidator = (fields: readonly OutputField[]): z.ZodType =>
    z.looseObject(Object.fromEntries(fields.map((field) => [field.name, field.required ? validatorFor(field) : validatorFor(field).optional()])));

// A worked example of the shape, so the prompt can show rather than describe: each value is the field's own
// description, in front of the model right as it fills that slot.
export const fieldsExample = (fields: readonly OutputField[]): Record<string, unknown> =>
    Object.fromEntries(
        fields.map((field) => {
            const hint = `${field.description}${field.required ? "" : " (optional, omit if it does not apply)"}`;
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

// One line per field, for surfaces with no room for an example: "risk (string, required), how likely …".
export const describeFields = (fields: readonly OutputField[]): string =>
    fields.map((field) => `- \`${field.name}\` (${field.type}${field.required ? ", required" : ", optional"}), ${field.description}`).join(`\n`);
