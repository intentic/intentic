import { createHoldingsIndex, type Share } from "../conversations/actor/conversation-holdings.js";
import type { DomainEventMap } from "../seams/domain-events.js";
import { notePersonOpening, personOpeningOf } from "./person-opening.js";

// The words a redirect card offers on are the ones a person opened a turn with: kept as they typed them, replaced by
// their next message, and left alone by a re-run or a turn anything other than a person opened.

const actorsOf = () => {
    const shares = new Map<string, Share>();
    return createHoldingsIndex((holder, create) => {
        const share = shares.get(holder) ?? (create ? new Map() : undefined);
        if (share !== undefined) {
            shares.set(holder, share);
        }
        return share;
    });
};

const started = (over: Partial<DomainEventMap["run.started"]> = {}): DomainEventMap["run.started"] => ({
    conversationId: "conv-1",
    speaker: { kind: "person", email: "Ada@Acme.test" },
    prompt: "fix the login bug in acme/app",
    resume: undefined,
    errand: undefined,
    ...over,
});

describe("person opening", () => {
    it("keeps a person's words, lower-casing who typed them, with the files that went along", () => {
        const actors = actorsOf();
        notePersonOpening(actors, started({ attachments: 2 }), 5);
        expect(personOpeningOf(actors, "conv-1")).toEqual({ email: "ada@acme.test", words: "fix the login bug in acme/app", attachments: 2, at: 5 });
    });

    it("is replaced by the person's next message, and left alone by a re-run or a turn nobody typed", () => {
        const actors = actorsOf();
        notePersonOpening(actors, started(), 1);
        notePersonOpening(actors, started({ prompt: "the re-run's words", resume: "memory" }), 2);
        notePersonOpening(actors, started({ prompt: "a child reported", speaker: { kind: "agent", conversationId: "conv-2" } }), 3);
        notePersonOpening(actors, started({ prompt: "an automation fired", speaker: { kind: "sandbox", source: "watch" } }), 4);
        expect(personOpeningOf(actors, "conv-1")?.words).toBe("fix the login bug in acme/app");
        notePersonOpening(actors, started({ prompt: "actually, the signup bug" }), 5);
        expect(personOpeningOf(actors, "conv-1")).toMatchObject({ words: "actually, the signup bug", attachments: 0, at: 5 });
    });

    it("holds nothing for a conversation no person has spoken in", () => {
        const actors = actorsOf();
        notePersonOpening(actors, started({ speaker: undefined }));
        expect(personOpeningOf(actors, "conv-1")).toBeUndefined();
    });
});
