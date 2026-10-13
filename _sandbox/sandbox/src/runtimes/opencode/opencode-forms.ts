import type { AgentReply, AskQuestion } from "@intentic/sandbox-contract";

// OpenCode's forms as question cards. Its `question` tool, and anything else that asks the person (an MCP server's
// elicitation), raises a form on the session and waits for its answer; the daemon draws the form as the same card the
// `ask` tool raises and answers the form from the card's reply (opencode-agent.ts).

// A form as far as a card reads it, whether it came on `form.created` or from the session's own list (two generated
// types of one shape).
interface FormOption {
    readonly value: string;
    readonly label: string;
    readonly description?: string;
}
type FormField = { readonly key: string; readonly title?: string; readonly description?: string; readonly hidden?: boolean } & (
    | { readonly type: "string"; readonly options?: readonly FormOption[] }
    | { readonly type: "multiselect"; readonly options: readonly FormOption[] }
    | { readonly type: "boolean" | "number" | "integer" | "external" }
);
export interface OpenCodeForm {
    readonly id: string;
    readonly sessionID: string;
    readonly fields: readonly FormField[];
}
type Answer = Record<string, string | number | boolean | readonly string[]>;
type QuestionReply = Extract<AgentReply, { kind: "question" }>;

// What OpenCode's tool hands the model when the card was dismissed: the form is cancelled with this as its message,
// which the question tool returns as the call's failure, so the model carries on rather than waiting.
export const FORM_DISMISSED =
    "The user dismissed these questions without answering. Carry on with sensible defaults, and say which ones you assumed.";

// A form a card cannot carry: a field that sends the person off to a page (`external`) has no answer a card could give.
export const FORM_UNRENDERABLE =
    "This form could not be shown to the user here. Carry on without an answer: make reasonable assumptions and say what you assumed.";

const BOOLEAN_OPTIONS = [
    { label: "Yes", description: "" },
    { label: "No", description: "" },
];

// The fields a person answers: a hidden field keeps its default, and is never put on a card.
const shown = (form: OpenCodeForm): FormField[] => form.fields.filter((field) => field.type === "external" || field.hidden !== true);

// What a card asks for one field. The question text is the field's own words (the tool puts its question in
// `description` and its short label in `title`), and doubles as the answer's key, so two fields saying the same thing
// are told apart by their key.
const questionOf = (field: Exclude<FormField, { type: "external" }>, taken: ReadonlySet<string>): AskQuestion => {
    const said = field.description ?? field.title ?? field.key;
    const question = taken.has(said) ? `${said} (${field.key})` : said;
    const header = field.title ?? field.key;
    if (field.type === "boolean") {
        return { question, header, multiSelect: false, options: BOOLEAN_OPTIONS };
    }
    if (field.type === "multiselect") {
        return { question, header, multiSelect: true, options: field.options.map((option) => ({ label: option.label, description: option.description ?? "" })) };
    }
    const options = field.type === "string" ? (field.options ?? []) : [];
    return { question, header, multiSelect: false, options: options.map((option) => ({ label: option.label, description: option.description ?? "" })) };
};

/** The card's questions for a form, each with the field it answers; undefined for a form no card can carry. */
export const formQuestions = (form: OpenCodeForm): { readonly field: FormField; readonly question: AskQuestion }[] | undefined => {
    const fields = shown(form);
    if (fields.length === 0 || fields.some((field) => field.type === "external")) {
        return undefined;
    }
    const taken = new Set<string>();
    return fields.flatMap((field) => {
        if (field.type === "external") {
            return [];
        }
        const question = questionOf(field, taken);
        taken.add(question.question);
        return [{ field, question }];
    });
};

// A chosen label as the option's value, else the person's own words as they typed them.
const valueOf = (options: readonly FormOption[] | undefined, picked: string): string =>
    options?.find((option) => option.label === picked)?.value ?? picked;

// One field's answer from the labels picked for its question; undefined leaves the field unanswered.
const fieldAnswer = (field: FormField, picked: readonly string[]): Answer[string] | undefined => {
    const first = picked[0];
    switch (field.type) {
        case "multiselect":
            return picked.length === 0 ? undefined : picked.map((label) => valueOf(field.options, label));
        case "boolean":
            return first === undefined ? undefined : first === "Yes";
        case "number":
        case "integer": {
            const value = Number(first);
            return first === undefined || Number.isNaN(value) ? undefined : value;
        }
        case "string":
            return first === undefined ? undefined : valueOf(field.options, first);
        case "external":
            return undefined;
    }
};

/** The form's answer from the card's reply, keyed by field; undefined when the card was dismissed. */
export const formAnswer = (questions: NonNullable<ReturnType<typeof formQuestions>>, reply: QuestionReply): Answer | undefined => {
    if (reply.cancelled === true || reply.answers === undefined) {
        return undefined;
    }
    const answer: Answer = {};
    for (const { field, question } of questions) {
        const value = fieldAnswer(field, reply.answers[question.question] ?? []);
        if (value !== undefined) {
            answer[field.key] = value;
        }
    }
    return answer;
};
