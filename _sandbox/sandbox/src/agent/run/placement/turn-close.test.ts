import { pino } from "pino";
import { SteeringQueue } from "../../checkpoints/agent-steering.js";
import { memoryFleet } from "../../../testing.js";
import { createHeldCards, type HeldOutcome } from "../../../guard/held-cards.js";
import { turnCloser } from "./turn-close.js";

// The close's first step: a body that ended reads no more words, so what is said from here must not go into its queue,
// where nothing would ever read it. Refused there, the words wait in the conversation's queue for its next turn.
test("hushing the turn refuses words into its steering, so a person's or a wake's wait for the next turn", () => {
    const { conversations } = memoryFleet();
    const steering = new SteeringQueue();
    conversations.registerTurn("c", { abort: () => undefined, steering });
    expect(conversations.steer("c", "before the close")).toBe(true);

    turnCloser(
        { conversations, heldCards: createHeldCards(async () => {}), scanPorts: async () => [], logger: pino({ level: "silent" }) },
        "c",
        steering,
    ).hush();

    expect(conversations.steer("c", "during the land")).toBe(false);
});

// The close's third step holds for a device card the agent stopped waiting on: the turn stays live until the card
// settles, and the yes it leaves is a wake already queued, so the conversation reads as running again by itself.
describe("a device card still up as the turn closes", () => {
    const held = (conversationId: string) => {
        const { conversations } = memoryFleet();
        const heldCards = createHeldCards(async (id, prompt) => {
            await conversations.send(id, {
                kind: "queue-joined",
                item: { id: "device-card-1", voice: "sandbox", queuedAt: 1, turn: { conversationId: id, prompt, messageId: "device-card-1" } },
            }).settled;
        });
        const settled = Promise.withResolvers<HeldOutcome>();
        const cancelled: string[] = [];
        heldCards.add(conversationId, {
            machine: "omen",
            command: "rm -rf /run/podman",
            typed: false,
            settled: settled.promise,
            cancel: () => {
                cancelled.push(conversationId);
                settled.resolve({ decision: "unanswered" });
            },
            carry: () => {},
        });
        const close = (signal?: AbortSignal) =>
            turnCloser({ conversations, heldCards, scanPorts: async () => [], logger: pino({ level: "silent" }) }, conversationId, undefined, signal);
        return { close, settle: settled.resolve, cancelled };
    };

    test("waits for the answer, and a yes leaves the conversation awaiting the wake that tells the agent", async () => {
        const { close, settle } = held("c-yes");
        let armed: boolean | undefined;
        const arming = close()
            .armWakes()
            .then((awaiting) => {
                armed = awaiting;
            });
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(armed).toBeUndefined();

        settle({ decision: "approved" });
        await arming;
        expect(armed).toBe(true);
    });

    test("a stop cancels the card and leaves nothing to wake for", async () => {
        const { close, cancelled } = held("c-stop");
        const stop = new AbortController();
        const arming = close(stop.signal).armWakes();
        stop.abort();

        expect(await arming).toBe(false);
        expect(cancelled).toEqual(["c-stop"]);
    });
});
