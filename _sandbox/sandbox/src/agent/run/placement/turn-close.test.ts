import { pino } from "pino";
import { SteeringQueue } from "../../checkpoints/agent-steering.js";
import { memoryFleet } from "../../../testing.js";
import { turnCloser } from "./turn-close.js";

// The close's first step: a body that ended reads no more words, so what is said from here must not go into its queue,
// where nothing would ever read it. Refused there, the words wait in the conversation's queue for its next turn.
test("hushing the turn refuses words into its steering, so a person's or a wake's wait for the next turn", () => {
    const { conversations } = memoryFleet();
    const steering = new SteeringQueue();
    conversations.registerTurn("c", { abort: () => undefined, steering });
    expect(conversations.steer("c", "before the close")).toBe(true);

    turnCloser({ conversations, scanPorts: async () => [], logger: pino({ level: "silent" }) }, "c", steering).hush();

    expect(conversations.steer("c", "during the land")).toBe(false);
});
