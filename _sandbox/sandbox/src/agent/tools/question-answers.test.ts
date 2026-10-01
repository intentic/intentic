import { answerFiles, formatAnswers, parseAnswers } from "./question-answers.js";

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
    /* One shape written, the same shape read: the recovery path (sessions.ts) has only the text the model was handed. */
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

    /* A screenshot with an own-words answer: named under its question, absolute against the agent's root, and read back. */
    it("names the files that went with an answer and reads them back", () => {
        const reply = {
            kind: "question" as const,
            requestId: "q1",
            answers: { "Which store?": ["SQLite"], "Deploy where?": ["like this"] },
            attachments: { "Deploy where?": [".intentic/records/artifacts/attachments/a/shot.png", "/tmp/b.pdf"] },
        };
        const text = formatAnswers(questions, reply, "/work");
        expect(text).toBe(
            [
                "The user answered:",
                "- Store: SQLite",
                "- Deploy where?: like this",
                "  - attached file (read it): /work/.intentic/records/artifacts/attachments/a/shot.png",
                "  - attached file (read it): /tmp/b.pdf",
                "",
                "The user attached files to their answer; read them with the Read tool before acting on it.",
            ].join("\n"),
        );
        expect(answerFiles(questions, reply, "/work")).toEqual(["/work/.intentic/records/artifacts/attachments/a/shot.png", "/tmp/b.pdf"]);
        // The stored result flattens the pictures that rode after the text into marks; the reading ignores them.
        expect(parseAnswers(questions, "q1", `${text}[image]`)).toEqual({
            ...reply,
            attachments: { "Deploy where?": ["/work/.intentic/records/artifacts/attachments/a/shot.png", "/tmp/b.pdf"] },
        });
    });

    it("hands no files over with a dismissal", () => {
        const dismissed = { kind: "question" as const, requestId: "q1", cancelled: true, attachments: { "Which store?": ["a.png"] } };
        expect(answerFiles(questions, dismissed)).toEqual([]);
    });

    // A result this module did not write (another runtime's ask, an error) is no answer at all, and the card
    // stays unanswered rather than wearing a decision nobody made.
    it("refuses text it did not write", () => {
        expect(parseAnswers(questions, "q1", "Tool failed: no user present")).toBeUndefined();
    });
});
