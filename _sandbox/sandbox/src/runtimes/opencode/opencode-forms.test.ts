import { formAnswer, formQuestions, type OpenCodeForm } from "./opencode-forms.js";

// OpenCode's forms as question cards and back. The `question` tool's form is the shape opencode 2.0.26 raises: one
// field per question, keyed `q<n>`, its header as the title and its question as the description, its options valued by
// their labels, a typed answer of the person's own always allowed.

const QUESTION_FORM: OpenCodeForm = {
    id: "frm_1",
    sessionID: "ses_1",
    fields: [
        {
            key: "q0",
            title: "Color",
            description: "Which color?",
            type: "string",
            options: [
                { value: "Red", label: "Red", description: "warm" },
                { value: "Blue", label: "Blue", description: "cool" },
            ],
        },
        {
            key: "q1",
            title: "Sizes",
            description: "Which sizes?",
            type: "multiselect",
            options: [
                { value: "s", label: "Small" },
                { value: "l", label: "Large" },
            ],
        },
    ],
};

test("a question form is one card question per field, its header and options as the tool wrote them", () => {
    expect(formQuestions(QUESTION_FORM)?.map((entry) => entry.question)).toEqual([
        {
            question: "Which color?",
            header: "Color",
            multiSelect: false,
            options: [
                { label: "Red", description: "warm" },
                { label: "Blue", description: "cool" },
            ],
        },
        {
            question: "Which sizes?",
            header: "Sizes",
            multiSelect: true,
            options: [
                { label: "Small", description: "" },
                { label: "Large", description: "" },
            ],
        },
    ]);
});

test("the card's reply answers each field by key: a label as its option's value, the person's own words as typed", () => {
    const questions = formQuestions(QUESTION_FORM) ?? [];

    expect(formAnswer(questions, { kind: "question", requestId: "r1", answers: { "Which color?": ["Blue"], "Which sizes?": ["Small", "Large"] } })).toEqual({
        q0: "Blue",
        q1: ["s", "l"],
    });
    expect(formAnswer(questions, { kind: "question", requestId: "r1", answers: { "Which color?": ["teal, please"] } })).toEqual({ q0: "teal, please" });
});

test("a dismissed card answers nothing, so the form is cancelled", () => {
    const questions = formQuestions(QUESTION_FORM) ?? [];

    expect(formAnswer(questions, { kind: "question", requestId: "r1", cancelled: true })).toBeUndefined();
    expect(formAnswer(questions, { kind: "question", requestId: "r1" })).toBeUndefined();
});

test("a yes-or-no field is two options, and a number field takes the typed number", () => {
    const form: OpenCodeForm = {
        id: "frm_2",
        sessionID: "ses_1",
        fields: [
            { key: "go", title: "Proceed", type: "boolean" },
            { key: "count", description: "How many?", type: "integer" },
            // A hidden field keeps its default and is never put on a card.
            { key: "token", type: "string", hidden: true },
        ],
    };
    const questions = formQuestions(form) ?? [];

    expect(questions.map((entry) => entry.question.question)).toEqual(["Proceed", "How many?"]);
    expect(questions[0]?.question.options.map((option) => option.label)).toEqual(["Yes", "No"]);
    expect(formAnswer(questions, { kind: "question", requestId: "r1", answers: { Proceed: ["No"], "How many?": ["3"] } })).toEqual({ go: false, count: 3 });
});

test("two fields asking the same thing stay apart on the card", () => {
    const form: OpenCodeForm = {
        id: "frm_3",
        sessionID: "ses_1",
        fields: [
            { key: "a", description: "Name?", type: "string" },
            { key: "b", description: "Name?", type: "string" },
        ],
    };

    expect(formQuestions(form)?.map((entry) => entry.question.question)).toEqual(["Name?", "Name? (b)"]);
});

// A field that sends the person off to a page has no answer a card could give, and a form with nothing to show has no
// card at all: either is cancelled rather than left parking the turn.
test("a form with a page to visit, or nothing to ask, is not a card", () => {
    expect(formQuestions({ id: "frm_4", sessionID: "ses_1", fields: [{ key: "auth", type: "external" }] })).toBeUndefined();
    expect(formQuestions({ id: "frm_5", sessionID: "ses_1", fields: [{ key: "secret", type: "string", hidden: true }] })).toBeUndefined();
});
