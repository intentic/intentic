import { describe, expect, it } from "vitest";
import { formatAnswers, parseAnswers } from "./question-answers.js";

const questions = [
    {
        question: "Which store?",
        header: "Store",
        multiSelect: true,
        options: [
            { label: "Postgres", description: "p" },
            { label: "SQLite", description: "s" },
        ],
    },
    { question: "Deploy where?", header: "", multiSelect: false, options: [{ label: "Fly", description: "f" }] },
];

describe("the ask tool's result", () => {
    /* One shape written, the same shape read: the recovery path (sessions.ts) has only the text the model was
     * handed, and it must come back as the reply the record would have kept, keyed by the question rather than
     * by the header the line was labelled with. */
    it("reads its own wording back as the reply that produced it", () => {
        const reply = {
            kind: "question" as const,
            requestId: "q1",
            answers: { "Which store?": ["Postgres", "SQLite"], "Deploy where?": ["my own box"] },
        };
        const text = formatAnswers(questions, reply);
        expect(text).toBe("The user answered:\n- Store: Postgres, SQLite\n- Deploy where?: my own box");
        expect(parseAnswers(questions, "q1", text)).toEqual(reply);
    });

    it("keeps a question the user left blank as an empty pick, not a missing one", () => {
        const reply = { kind: "question" as const, requestId: "q1", answers: { "Which store?": ["SQLite"] } };
        expect(parseAnswers(questions, "q1", formatAnswers(questions, reply))).toEqual({
            kind: "question",
            requestId: "q1",
            answers: { "Which store?": ["SQLite"], "Deploy where?": [] },
        });
    });

    it("reads a dismissal back as the cancellation it was", () => {
        const dismissed = { kind: "question" as const, requestId: "q1", cancelled: true };
        expect(parseAnswers(questions, "q1", formatAnswers(questions, dismissed))).toEqual(dismissed);
    });

    // A result this module did not write (another runtime's ask, an error) is no answer at all, and the card
    // stays unanswered rather than wearing a decision nobody made.
    it("refuses text it did not write", () => {
        expect(parseAnswers(questions, "q1", "Tool failed: no user present")).toBeUndefined();
    });
});
