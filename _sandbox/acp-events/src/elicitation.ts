import type { CreateElicitationRequest, CreateElicitationResponse, ElicitationContentValue } from "@agentclientprotocol/sdk/unstable";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import type { AskQuestion } from "@intentic/sandbox-contract/events/requests";
import { z } from "zod";

// ACP's form elicitation (`elicitation/create`, mode `form`) as the question card every runtime shares. Each property
// of the requested schema is one question on the card:
// - a string with `enum` or `oneOf`: one choice;
// - an array whose items carry `enum` or `anyOf`: several choices;
// - a boolean: Yes or No;
// - a plain string, a number or an integer: the card's own free-text answer, a number read back as one.
// A property no question fits (a future type) is left out when optional; a required one declines the whole form, since
// no answer the card could collect would satisfy it. URL elicitation is never asked on a card. Where the card parks and
// who answers it is each caller's own: the daemon's parked cards (its runtimes/acp/acp-elicitation.ts), a computer's turn.

// The header every card from an ACP agent wears: the protocol says what is asked, not who in the agent asks it.
const HEADER = "Agent question";
const YES = "Yes";
const NO = "No";

// The two answers that carry no content: the form cannot be asked or was answered with what its schema cannot take, and
// the person put the card away (or the turn ended first).
export const ELICITATION_DECLINED: CreateElicitationResponse = { action: "decline" };
export const ELICITATION_CANCELLED: CreateElicitationResponse = { action: "cancel" };

// One property as a question, and how the person's answer reads back as the value the schema asked for. `read` answers
// undefined for an answer the schema cannot take (own words where only listed choices are valid, a number that is none).
interface Field {
    readonly key: string;
    readonly required: boolean;
    readonly question: Omit<AskQuestion, "question" | "header">;
    readonly label: string;
    readonly description: string | undefined;
    readonly read: (picks: readonly string[]) => ElicitationContentValue | undefined;
}

// A text the agent may or may not fill: blank or another type reads as absent rather than failing the form.
const optionalText = z
    .string()
    .refine((value) => value.trim() !== "")
    .optional()
    .catch(undefined);

// Titled choices (`oneOf` on a string, `anyOf` on an array's items) and bare ones (`enum`); one malformed entry is
// dropped rather than failing the list.
const TitledChoicesSchema = z
    .array(z.object({ const: z.string(), title: optionalText, description: optionalText }).nullable().catch(null))
    .transform((entries) => entries.flatMap((entry) => (entry === null ? [] : [{ label: entry.title ?? entry.const, value: entry.const, description: entry.description ?? "" }])));
const BareChoicesSchema = z
    .array(z.string().nullable().catch(null))
    .transform((entries) => entries.flatMap((value) => (value === null ? [] : [{ label: value, value, description: "" }])));

const described = { title: optionalText, description: optionalText };

// The property kinds a question fits, parsed at the door. Anything else (a future type) fails the parse and is
// handled as a property no card can ask.
const PropertySchema = z.discriminatedUnion("type", [
    z.object({
        type: z.literal("string"),
        ...described,
        oneOf: TitledChoicesSchema.optional().catch(undefined),
        enum: BareChoicesSchema.optional().catch(undefined),
    }),
    z.object({
        type: z.literal("array"),
        ...described,
        items: z.object({ anyOf: TitledChoicesSchema.optional().catch(undefined), enum: BareChoicesSchema.optional().catch(undefined) }),
    }),
    z.object({ type: z.literal("boolean"), ...described }),
    z.object({ type: z.enum(["number", "integer"]), ...described }),
]);
type Property = z.infer<typeof PropertySchema>;
type Choice = { readonly label: string; readonly value: string; readonly description: string };

const FormSchema = z.object({
    properties: z.record(z.string(), z.unknown()).optional().catch(undefined),
    required: z.array(z.string()).nullable().optional().catch(undefined),
});

// A pick read back as its value: a label shown, or the value itself typed in the person's own words.
const valueOf = (choices: readonly Choice[], pick: string): string | undefined =>
    choices.find((choice) => choice.label === pick || choice.value === pick)?.value;

const shown = (choices: readonly Choice[]): AskQuestion["options"] => choices.map(({ label, description }) => ({ label, description }));

const fieldOf = (key: string, property: Property, required: boolean): Field | undefined => {
    const base = { key, required, label: property.title ?? key, description: property.description };
    switch (property.type) {
        case "string": {
            const choices = property.oneOf ?? property.enum;
            if (choices !== undefined && choices.length > 0) {
                return {
                    ...base,
                    question: { multiSelect: false, options: shown(choices) },
                    read: (picks) => (picks[0] === undefined ? undefined : valueOf(choices, picks[0])),
                };
            }
            return { ...base, question: { multiSelect: false, options: [] }, read: (picks) => picks[0] };
        }
        case "array": {
            const choices = property.items.anyOf ?? property.items.enum;
            if (choices === undefined || choices.length === 0) {
                return undefined;
            }
            return {
                ...base,
                question: { multiSelect: true, options: shown(choices) },
                read: (picks) => {
                    const values = picks.flatMap((pick) => valueOf(choices, pick) ?? []);
                    return values.length === 0 ? undefined : values;
                },
            };
        }
        case "boolean":
            return {
                ...base,
                question: {
                    multiSelect: false,
                    options: [
                        { label: YES, description: "" },
                        { label: NO, description: "" },
                    ],
                },
                // An answer in the person's own words is neither.
                read: (picks) => (picks[0] === YES ? true : picks[0] === NO ? false : undefined),
            };
        case "number":
        case "integer": {
            const integer = property.type === "integer";
            return {
                ...base,
                question: { multiSelect: false, options: [] },
                read: (picks) => {
                    const parsed = picks[0] === undefined || picks[0].trim() === "" ? Number.NaN : Number(picks[0]);
                    return Number.isFinite(parsed) && (!integer || Number.isInteger(parsed)) ? parsed : undefined;
                },
            };
        }
    }
};

// The card for one form, and how its reply becomes the agent's content; undefined when the card cannot ask it.
export const elicitationForm = (
    request: CreateElicitationRequest,
): { readonly questions: readonly AskQuestion[]; readonly answer: (reply: Extract<AgentReply, { kind: "question" }>) => CreateElicitationResponse } | undefined => {
    if (request.mode !== "form" || !("requestedSchema" in request)) {
        return undefined;
    }
    const schema = FormSchema.parse(request.requestedSchema);
    const required = new Set(schema.required ?? []);
    const fields: Field[] = [];
    for (const [key, raw] of Object.entries(schema.properties ?? {})) {
        const parsed = PropertySchema.safeParse(raw);
        const field = parsed.success ? fieldOf(key, parsed.data, required.has(key)) : undefined;
        if (field === undefined) {
            if (required.has(key)) {
                return undefined;
            }
            continue;
        }
        fields.push(field);
    }
    // Answers are keyed by question text, so each must be its own: the form's message opens the first, and a label
    // that would repeat another's carries its property's key.
    const seen = new Set<string>();
    const asked = fields.map((field, index) => {
        const own = field.description === undefined || field.description === field.label ? field.label : `${field.label}: ${field.description}`;
        const opening = index === 0 && request.message.trim() !== "" ? `${request.message.trim()}\n\n${own}` : own;
        const question = seen.has(opening) ? `${opening} (${field.key})` : opening;
        seen.add(question);
        return { field, question: { question, header: HEADER, ...field.question } };
    });
    // A form with nothing to ask is still a request for a yes: it asks the message alone.
    const questions: AskQuestion[] =
        asked.length > 0
            ? asked.map((entry) => entry.question)
            : [{ question: request.message, header: HEADER, multiSelect: false, options: [{ label: YES, description: "" }, { label: NO, description: "" }] }];
    return {
        questions,
        answer: (reply) => {
            if (reply.cancelled === true) {
                return ELICITATION_CANCELLED;
            }
            if (asked.length === 0) {
                return reply.answers?.[request.message]?.[0] === YES ? { action: "accept", content: {} } : ELICITATION_DECLINED;
            }
            const content: Record<string, ElicitationContentValue> = {};
            for (const { field, question } of asked) {
                const value = field.read(reply.answers?.[question.question] ?? []);
                if (value !== undefined) {
                    content[field.key] = value;
                } else if (field.required) {
                    // An answer the schema can't take: the agent hears a no rather than a value it never asked for.
                    return ELICITATION_DECLINED;
                }
            }
            return { action: "accept", content };
        },
    };
};
