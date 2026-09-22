import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { test, expect } from "bun:test";
import type { Services } from "../composition.js";
import { fileWebchatOutbox, outboxKeyOf, outboxStreamFor, outboxTurnStream } from "./webchat-outbox.js";

const store = () => fileWebchatOutbox(join(mkdtempSync(join(tmpdir(), "webchat-outbox-")), "outbox.json"));

const KEY = "webchat:guest:visitor-1";
const DAY = 24 * 60 * 60 * 1000;

test("a queued reply comes back once and then is behind the cursor", async () => {
    const outbox = store();
    const now = Date.now();
    const seq = await outbox.append(KEY, "we looked into it", now);

    const first = await outbox.since(KEY, 0, now);
    expect(first.replies).toMatchObject([{ seq, text: "we looked into it" }]);
    expect(first.cursor).toBe(seq);

    // The same poll again, with what the last one handed back: the visitor is not shown the answer twice.
    expect((await outbox.since(KEY, first.cursor, now)).replies).toEqual([]);
});

test("seqs increase per thread, and threads do not see each other's replies", async () => {
    const outbox = store();
    const now = Date.now();
    const first = await outbox.append(KEY, "one", now);
    const second = await outbox.append(KEY, "two", now + 1);
    expect(second).toBeGreaterThan(first);

    await outbox.append("webchat:guest:visitor-2", "someone else's", now + 2);
    expect((await outbox.since(KEY, 0, now + 3)).replies.map((reply) => reply.text)).toEqual(["one", "two"]);
});

test("an empty reply is not queued: a turn that answered nothing owes the visitor no bubble", async () => {
    const outbox = store();
    const now = Date.now();
    await outbox.append(KEY, "   \n  ", now);
    expect((await outbox.since(KEY, 0, now)).replies).toEqual([]);
});

test("a thread past its TTL reads as empty, and writing to it starts a fresh run of seqs", async () => {
    const outbox = store();
    const now = Date.now();
    await outbox.append(KEY, "stale", now);
    const later = now + 31 * DAY;
    expect((await outbox.since(KEY, 0, later)).replies).toEqual([]);
    // The expired thread is gone rather than resumed, so the new reply is seq 1 again and a cursor of 0 collects it.
    await outbox.append(KEY, "fresh", later);
    expect((await outbox.since(KEY, 0, later)).replies).toMatchObject([{ seq: 1, text: "fresh" }]);
});

test("a trimmed-away reply moves the cursor past it rather than leaving the visitor waiting for a seq that is gone", async () => {
    const outbox = store();
    const now = Date.now();
    // Past MAX_PER_THREAD (50): the oldest are dropped, but seqs are never reissued.
    for (let index = 0; index < 60; index += 1) {
        await outbox.append(KEY, `reply ${index}`, now + index);
    }
    const { replies, cursor } = await outbox.since(KEY, 0, now + 60);
    expect(replies).toHaveLength(50);
    expect(replies[0]?.text).toBe("reply 10");
    expect(cursor).toBe(60);
    expect((await outbox.since(KEY, cursor, now + 60)).replies).toEqual([]);
});

test("only a Visitor chat origin names an outbox thread", () => {
    expect(outboxKeyOf({ automationId: "guest", provider: "webchat", channelId: "visitor-1" })).toBe(KEY);
    // A Discord conversation answers through its gateway; claiming an outbox for it would swallow the reply.
    expect(outboxKeyOf({ automationId: "guest", provider: "discord", channelId: "123" })).toBeUndefined();
    // A webhook wake has no thread to answer into.
    expect(outboxKeyOf({ automationId: "guest", provider: "webchat" })).toBeUndefined();
    expect(outboxKeyOf(undefined)).toBeUndefined();
});

const servicesWith = (outbox: ReturnType<typeof store>): Services =>
    unstubbed<Services>("services", {
        webchatOutbox: outbox,
        logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }),
    });

test("the turn stream queues the whole answer on end, not a bubble per delta", async () => {
    const outbox = store();
    const sink = outboxTurnStream(servicesWith(outbox), KEY);
    sink.stream.delta("half a ");
    sink.stream.delta("sentence");
    sink.stream.end();
    // `settled` is the whole point of the sink: awaiting it, not a timer, is what makes the reply readable.
    await sink.settled();
    expect((await outbox.since(KEY, 0, Date.now())).replies).toMatchObject([{ text: "half a sentence" }]);
});

test("a turn that failed queues nothing: the visitor is left to a human, not to the owner's error text", async () => {
    const outbox = store();
    const sink = outboxTurnStream(servicesWith(outbox), KEY);
    sink.stream.failed("the model provider refused this run");
    sink.stream.end();
    await sink.settled();
    expect((await outbox.since(KEY, 0, Date.now())).replies).toEqual([]);
});

test("a wake with no Visitor chat origin gets no sink, so every other provider's release is unchanged", () => {
    const services = servicesWith(store());
    expect(outboxStreamFor(services, { automationId: "guest", provider: "discord", channelId: "123" })).toBeUndefined();
    expect(outboxStreamFor(services, undefined)).toBeUndefined();
});

test("a Visitor chat wake's sink writes into that visitor's own thread", async () => {
    const outbox = store();
    const sink = outboxStreamFor(servicesWith(outbox), { automationId: "guest", provider: "webchat", channelId: "visitor-1" });
    sink?.stream.delta("approved answer");
    sink?.stream.end();
    await sink?.settled();
    expect((await outbox.since(KEY, 0, Date.now())).replies).toMatchObject([{ text: "approved answer" }]);
});
