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
    rescheduled,
    returned,
    scheduled,
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

// The bug these pin (2026-10-06): the queue held ONE booking, so booking a second message re-timed the first, a plain
// send let every booked message go early, and a Stop's hold and a booking could not stand side by side. Each message now
// carries its own booking, and the queue-level fields are only the soonest of them, for editors and daemons older than
// that.
describe("a conversation's queue, booking each message on its own", () => {
    const HOUR = 3_600_000;
    const TOMORROW = 86_400_000;

    it("keeps each booked message on its own time: booking a second does not re-time the first", () => {
        const first = scheduled(NO_QUEUE, message("m1", "do the thing"), { until: HOUR });
        const both = scheduled(first, message("m2", "second thing"), { until: TOMORROW });
        expect(both.items.map(({ id, until }) => ({ id, until }))).toEqual([
            { id: "m1", until: HOUR },
            { id: "m2", until: TOMORROW },
        ]);
        expect(queueView(both).items.map(({ id, until }) => ({ id, until }))).toEqual([
            { id: "m1", until: HOUR },
            { id: "m2", until: TOMORROW },
        ]);
    });

    it("lets the sooner booking go first, whichever was booked first, and the later one keeps its time", () => {
        const late = scheduled(NO_QUEUE, message("m1", "at five"), { until: 17 * HOUR });
        const both = scheduled(late, message("m2", "at three"), { until: 15 * HOUR });
        // The queue-level fields are the soonest booking: what an older editor draws and an older daemon holds by.
        expect(both).toMatchObject({ paused: "scheduled", until: 15 * HOUR });
        const threeWent = released(both, ["m2"]);
        expect(threeWent.items.map(({ id, until }) => ({ id, until }))).toEqual([
            { id: "m1", until: 17 * HOUR },
            { id: "m2", until: undefined },
        ]);
        expect(threeWent).toMatchObject({ paused: "scheduled", until: 17 * HOUR });
    });

    it("leaves every booking standing when a person sends a message the ordinary way", () => {
        const booked = scheduled(NO_QUEUE, message("m1", "one"), { until: HOUR });
        const sent = joined(booked, message("m2", "two"));
        expect(sent.items.map(({ id, until }) => ({ id, until }))).toEqual([
            { id: "m1", until: HOUR },
            { id: "m2", until: undefined },
        ]);
        expect(sent).toMatchObject({ paused: "scheduled", until: HOUR });
    });

    it("holds the unbooked messages on a stop and leaves the booked ones on their time", () => {
        const booked = scheduled(NO_QUEUE, message("m1", "one"), { until: HOUR });
        const stopped = hold(joined(booked, message("m2", "two")), "stopped");
        expect(stopped.paused).toBe("stopped");
        expect(stopped.items.map(({ id, until }) => ({ id, until }))).toEqual([
            { id: "m1", until: HOUR },
            { id: "m2", until: undefined },
        ]);
        // Once the held message has gone, the booking is all that waits, and the queue reads as scheduled again.
        expect(taken(stopped, ["m2"])).toMatchObject({ paused: "scheduled", until: HOUR });
    });

    it("keeps the booked messages' times when a refusal hands words back, held, ahead of them", () => {
        const booked = scheduled(NO_QUEUE, message("m1", "one"), { until: HOUR });
        const back = returned(booked, [message("m0", "zero")]);
        expect(back.paused).toBe("refused");
        expect(back.items.map(({ id, until }) => ({ id, until }))).toEqual([
            { id: "m0", until: undefined },
            { id: "m1", until: HOUR },
        ]);
    });

    it("shows the soonest booking at the queue level, an instant before any land", () => {
        const after = { conversationId: "brave-otter-k2", since: 4_000 };
        const byLand = scheduled(NO_QUEUE, message("m1", "one"), { after });
        expect(byLand).toMatchObject({ paused: "scheduled", after });
        const both = scheduled(scheduled(byLand, message("m2", "two"), { until: HOUR }), message("m3", "three"), { until: TOMORROW });
        expect(both).toMatchObject({ paused: "scheduled", until: HOUR });
        expect(both).not.toHaveProperty("after");
        expect(queueView(both)).toMatchObject({ paused: "scheduled", until: HOUR });
    });
});

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
        // Sending lets the stop go, never a booking: the queue then reads as scheduled at that booking's time.
        const booked = hold(scheduled(waiting(message("m1", "one")), message("b1", "later"), { until: 9_000 }), "stopped");
        expect(booked.paused).toBe("stopped");
        expect(joined(booked, message("m2", "two"))).toMatchObject({ paused: "scheduled", until: 9_000, items: [{ id: "m1" }, { id: "b1", until: 9_000 }, { id: "m2" }] });
    });

    it("books a scheduled send by its own instant, keeps it through edits, and lets every booking go on a release naming none", () => {
        const booked = scheduled(NO_QUEUE, message("m1", "one"), { until: 5_000 });
        expect(booked).toMatchObject({ paused: "scheduled", until: 5_000, items: [{ id: "m1", until: 5_000 }] });
        expect(queueView(booked)).toMatchObject({ paused: "scheduled", until: 5_000, items: [{ id: "m1", until: 5_000 }] });
        // A second scheduled send joins it on its own time, and the first keeps its own.
        const both = scheduled(booked, message("m2", "two"), { until: 6_000 });
        expect(both.items.map(({ id, until }) => ({ id, until }))).toEqual([
            { id: "m1", until: 5_000 },
            { id: "m2", until: 6_000 },
        ]);
        expect(both.until).toBe(5_000);
        const reworded = edited(both, "m1", 1, "one, better");
        expect(reworded.queue).toMatchObject({ paused: "scheduled", until: 5_000, items: [{ id: "m1", until: 5_000 }, { id: "m2" }] });
        // A plain send is the person saying "now" about that message only: the bookings stay on their times.
        expect(joined(both, message("m3", "three"))).toMatchObject({ paused: "scheduled", until: 5_000 });
        // A release that names nothing is an older editor's Resume, which meant the whole queue.
        expect(released(both)).toEqual({ items: both.items.map(({ until: _until, ...item }) => item), revision: both.revision + 1 });
        // Emptied, nothing is left scheduled.
        expect(removed(booked, "m1", 1).queue).toEqual({ items: [], revision: 2 });
    });

    // A booking is the person's own appointment: a stop ends the running turn, and the agent must not carry on by itself,
    // but it says nothing about a message the person booked for later.
    it("keeps a booking through a stop, which has nothing unbooked to hold", () => {
        const byTime = scheduled(NO_QUEUE, message("m1", "one"), { until: 5_000 });
        expect(hold(byTime, "stopped")).toBe(byTime);
        const after = { conversationId: "brave-otter-k2", since: 4_000 };
        const byLand = scheduled(NO_QUEUE, message("m1", "one"), { after });
        expect(hold(byLand, "stopped")).toBe(byLand);
        // A message waiting unbooked beside it is held, and the booking stands.
        expect(hold(joined(byTime, message("m2", "two")), "stopped")).toMatchObject({
            paused: "stopped",
            items: [{ id: "m1", until: 5_000 }, { id: "m2" }],
        });
    });

    it("books a send for another conversation's land, shows only which one, and keeps each message's booking its own", () => {
        const after = { conversationId: "brave-otter-k2", since: 4_000 };
        const waitingOn = scheduled(NO_QUEUE, message("m1", "one"), { after });
        expect(waitingOn).toEqual({ items: [expect.objectContaining({ id: "m1", revision: 1, after })], revision: 1, paused: "scheduled", after });
        expect(queueView(waitingOn)).toEqual({
            items: [{ id: "m1", text: "one", voice: "person", queuedAt: 1_000, revision: 1, after: "brave-otter-k2" }],
            revision: 1,
            paused: "scheduled",
            after: "brave-otter-k2",
        });
        // A time booked after it stands beside the land, never in its place; the queue-level shadow is the instant.
        const timed = scheduled(waitingOn, message("m2", "two"), { until: 9_000 });
        expect(timed.items.map(({ id, until, after: land }) => ({ id, until, land }))).toEqual([
            { id: "m1", until: undefined, land: after },
            { id: "m2", until: 9_000, land: undefined },
        ]);
        expect(timed).toMatchObject({ paused: "scheduled", until: 9_000 });
        expect(timed).not.toHaveProperty("after");
        // Edits keep it, and so does a plain send; a release of that one message lets it go.
        expect(edited(waitingOn, "m1", 1, "one, better").queue).toMatchObject({ paused: "scheduled", after, items: [{ after }] });
        expect(joined(waitingOn, message("m4", "four"))).toMatchObject({ paused: "scheduled", after, items: [{ after }, { id: "m4" }] });
        expect(released(waitingOn, ["m1"])).toEqual({ items: [expect.not.objectContaining({ after })], revision: 2 });
    });

    it("re-times what already waits, whatever held it, only the messages named when any are, and nothing when nothing waits", () => {
        const stopped = hold(waiting(message("m1", "one"), message("m2", "two")), "stopped");
        const retimed = rescheduled(stopped, { until: 7_000 });
        expect(retimed).toMatchObject({ paused: "scheduled", until: 7_000, revision: stopped.revision + 1 });
        expect(retimed.items.map(({ id, until }) => ({ id, until }))).toEqual([
            { id: "m1", until: 7_000 },
            { id: "m2", until: 7_000 },
        ]);
        // Messages that waited unheld behind a running turn are booked too.
        expect(rescheduled(waiting(message("m1", "one")), { until: 7_000 })).toMatchObject({ paused: "scheduled", until: 7_000 });
        expect(rescheduled(NO_QUEUE, { until: 7_000 })).toBe(NO_QUEUE);
        // Naming one re-times that one: the other keeps its own time, and the stop still holds what has none.
        const one = rescheduled(retimed, { until: 9_000 }, ["m2"]);
        expect(one.items.map(({ id, until }) => ({ id, until }))).toEqual([
            { id: "m1", until: 7_000 },
            { id: "m2", until: 9_000 },
        ]);
        expect(rescheduled(stopped, { until: 9_000 }, ["m1"])).toMatchObject({ paused: "stopped", items: [{ id: "m1", until: 9_000 }, { id: "m2" }] });
    });

    it("carries an instant only on a queue with a message booked for one", () => {
        const booked = scheduled(NO_QUEUE, message("m1", "one"), { until: 5_000 });
        expect(hold(released(booked), "stopped")).not.toHaveProperty("until");
        // A refusal's hold stands for the words it handed back; the booking stays on its message, not on the queue.
        const back = returned(booked, [message("m0", "zero")]);
        expect(back).toMatchObject({ paused: "refused", items: [{ id: "m0" }, { id: "m1", until: 5_000 }] });
        expect(back).not.toHaveProperty("until");
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
