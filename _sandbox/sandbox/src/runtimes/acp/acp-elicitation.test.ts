import type { CreateElicitationRequest } from "@agentclientprotocol/sdk";
import { elicitationForm } from "./acp-elicitation.js";

const form = (properties: Record<string, unknown>, required: string[] = [], message = "Pick"): CreateElicitationRequest => ({
    sessionId: "s",
    mode: "form",
    message,
    // SAFETY: the tests hand malformed and future property kinds on purpose; the form is read through its parser.
    requestedSchema: { type: "object", properties: properties as never, required },
});

const reply = (answers: Record<string, string[]>) => ({ kind: "question" as const, requestId: "r", answers });

test("each property kind becomes the question that fits it", () => {
    const asked = elicitationForm(
        form({
            color: { type: "string", enum: ["red", "blue"] },
            tags: { type: "array", items: { anyOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] } },
            ok: { type: "boolean", title: "OK?" },
            name: { type: "string", description: "Your name" },
            count: { type: "integer" },
        }),
    );
    expect(asked?.questions.map((question) => [question.question, question.multiSelect, question.options.map((option) => option.label)])).toEqual([
        ["Pick\n\ncolor", false, ["red", "blue"]],
        ["tags", true, ["Alpha", "Beta"]],
        ["OK?", false, ["Yes", "No"]],
        ["name: Your name", false, []],
        ["count", false, []],
    ]);
});

test("the person's picks go back as the values the schema named, a number as a number", () => {
    const asked = elicitationForm(
        form({ tags: { type: "array", items: { anyOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] } }, count: { type: "integer" } }),
    );
    expect(asked?.answer(reply({ "Pick\n\ntags": ["Alpha", "Beta"], count: ["3"] }))).toEqual({ action: "accept", content: { tags: ["a", "b"], count: 3 } });
});

test("an answer a required field cannot take is a decline, an optional one is left out", () => {
    const asked = elicitationForm(form({ count: { type: "integer" }, note: { type: "number" } }, ["count"]));
    expect(asked?.answer(reply({ "Pick\n\ncount": ["three"], note: ["1.5"] }))).toEqual({ action: "decline" });
    expect(asked?.answer(reply({ "Pick\n\ncount": ["2"], note: ["lots"] }))).toEqual({ action: "accept", content: { count: 2 } });
});

test("a dismissed card is the protocol's cancel", () => {
    expect(elicitationForm(form({ ok: { type: "boolean" } }))?.answer({ kind: "question", requestId: "r", cancelled: true })).toEqual({ action: "cancel" });
});

test("a required property no card can ask declines the form outright; an optional one is left out", () => {
    expect(elicitationForm(form({ blob: { type: "object" } }, ["blob"]))).toBeUndefined();
    expect(elicitationForm(form({ blob: { type: "object" }, ok: { type: "boolean" } }))?.questions).toHaveLength(1);
});

test("URL elicitation is never asked on a card", () => {
    expect(elicitationForm({ sessionId: "s", mode: "url", message: "Sign in", elicitationId: "e", url: "https://example.com" })).toBeUndefined();
});
