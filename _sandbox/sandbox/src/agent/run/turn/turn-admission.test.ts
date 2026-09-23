import { expect, test } from "bun:test";
import type { QueuedItem } from "../../../agents/actor/conversation-queue.js";
import { together } from "./turn-admission.js";

// Which waiting messages leave as one turn. A turn carries one sender's attribution, ownership and fence, so a batch
// must never join two senders' words, however they were queued.

const item = (id: string, voice: QueuedItem["voice"], actor?: string): QueuedItem => ({
    id,
    voice,
    ...(actor === undefined ? {} : { actor }),
    queuedAt: 0,
    revision: 1,
    turn: { prompt: id, conversationId: "c1", messageId: id },
});

test("one person's messages in a row leave together, and a second person's wait for their own turn", () => {
    const queue = [item("a1", "person", "alice"), item("a2", "person", "alice"), item("b1", "person", "bob"), item("a3", "person", "alice")];
    expect(together(queue).map((waiting) => waiting.id)).toEqual(["a1", "a2"]);
    expect(together(queue.slice(2)).map((waiting) => waiting.id)).toEqual(["b1"]);
});

test("the sandbox's own words leave alone, and a person's stop short of them", () => {
    expect(together([item("w1", "sandbox"), item("a1", "person", "alice")]).map((waiting) => waiting.id)).toEqual(["w1"]);
    expect(together([item("a1", "person", "alice"), item("w1", "sandbox")]).map((waiting) => waiting.id)).toEqual(["a1"]);
});
