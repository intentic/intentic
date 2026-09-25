import {
    edited,
    hold,
    joined,
    NO_QUEUE,
    type QueuedItem,
    queueView,
    released,
    removed,
    rerouted,
    returned,
    taken,
    type TurnQueue,
} from "./conversation-queue.js";

// Pins every change a conversation's queue can go through, as values: what joins and leaves, what a hold keeps, and how
// an edit made against an older copy is refused rather than written over somebody else's.

const message = (id: string, prompt: string, over: Partial<Omit<QueuedItem, "revision">> = {}): Omit<QueuedItem, "revision"> => ({
    id,
    voice: "person",
    queuedAt: 1_000,
    turn: { conversationId: "c1", prompt, messageId: id, agent: "codex", harness: "native", account: "acct-1", model: "gpt-6" },
    ...over,
});

const waiting = (...items: Omit<QueuedItem, "revision">[]): TurnQueue => items.reduce(joined, NO_QUEUE);

describe("a conversation's queue", () => {
    it("takes messages in the order they came, each written at the revision it moved the queue to", () => {
        const queue = waiting(message("m1", "one"), message("m2", "two"));
        expect(queue.revision).toBe(2);
        expect(queue.items.map(({ id, revision }) => ({ id, revision }))).toEqual([
            { id: "m1", revision: 1 },
            { id: "m2", revision: 2 },
        ]);
    });

    it("takes the same message once, however often it is sent", () => {
        const queue = waiting(message("m1", "one"));
        expect(joined(queue, message("m1", "one"))).toBe(queue);
    });

    it("is held by a stop, and a person sending again lets it go; the sandbox's own words do not", () => {
        const stopped = hold(waiting(message("m1", "one")), "stopped");
        expect(stopped.paused).toBe("stopped");
        expect(joined(stopped, message("w1", "Watch fired", { voice: "sandbox" })).paused).toBe("stopped");
        expect(joined(stopped, message("m2", "two")).paused).toBeUndefined();
    });

    it("holds nothing when nothing waits, and forgets its hold once what it held is gone", () => {
        expect(hold(NO_QUEUE, "stopped")).toBe(NO_QUEUE);
        const stopped = hold(waiting(message("m1", "one")), "stopped");
        expect(taken(stopped, ["m1"])).toEqual({ items: [], revision: 3 });
        expect(released(stopped)).toMatchObject({ revision: 3 });
        expect(released(stopped).paused).toBeUndefined();
    });

    it("puts refused words back at its head, held, ahead of what came after them", () => {
        const queue = waiting(message("m2", "two"));
        const back = returned(queue, [message("m1", "one")]);
        expect(back.items.map((item) => item.id)).toEqual(["m1", "m2"]);
        expect(back.paused).toBe("refused");
    });

    it("rewords or takes back a message only as it was read", () => {
        const queue = waiting(message("m1", "fix the @src/app.ts test"));
        expect(edited(queue, "m1", 0, "fix it").change).toBe("stale");
        expect(edited(queue, "m9", 1, "fix it").change).toBe("missing");
        const { queue: reworded, change } = edited(queue, "m1", 1, "fix the @docs/a.md typo instead");
        expect(change).toBe("done");
        // The mentions are the new words' own, not the old ones'.
        expect(reworded.items[0]).toMatchObject({ revision: 2, turn: { prompt: "fix the @docs/a.md typo instead", mentions: ["docs/a.md"] } });
        expect(removed(reworded, "m1", 1).change).toBe("stale");
        expect(removed(reworded, "m1", 2)).toEqual({ queue: { items: [], revision: 3 }, change: "done" });
    });

    it("points a person's waiting words at who a resume names to serve them, keeping their own model when it names none", () => {
        const queue = waiting(message("m1", "one"), message("w1", "Watch fired", { voice: "sandbox" }));
        const moved = rerouted(queue, { agent: "claude", harness: "native", account: "acct-2" });
        expect(moved.items.map((item) => item.turn)).toEqual([
            { conversationId: "c1", prompt: "one", messageId: "m1", agent: "claude", harness: "native", account: "acct-2", model: "gpt-6" },
            { conversationId: "c1", prompt: "Watch fired", messageId: "w1", agent: "codex", harness: "native", account: "acct-1", model: "gpt-6" },
        ]);
    });

    it("shows every window the words, their files and whose they are, never the request behind them", () => {
        const queue = hold(
            waiting(message("m1", "look", { turn: { conversationId: "c1", prompt: "look", attachments: ["shot.png"], agent: "codex" } })),
            "refused",
        );
        expect(queueView(queue)).toEqual({
            items: [{ id: "m1", text: "look", attachments: ["shot.png"], voice: "person", queuedAt: 1_000, revision: 1 }],
            revision: 2,
            paused: "refused",
        });
    });
});
