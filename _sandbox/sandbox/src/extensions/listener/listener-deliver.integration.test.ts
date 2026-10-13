import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { fileWebchatOutbox } from "../../webchat/webchat-outbox.js";
import { channelAnswerSink, deliverToListenerChannel, gatewayDeliveryOf } from "./listener-deliver.js";

// The core-door half of "speak as the agent". A Visitor chat has no gateway extension and never will, so without this
// leg `place` on a visitor's conversation reported "nothing is listening" and the words reached only the transcript.

const harness = () => {
    const outbox = fileWebchatOutbox(join(mkdtempSync(join(tmpdir(), "listener-deliver-")), "outbox.json"));
    return {
        outbox,
        services: unstubbed<Services>("services", { webchatOutbox: outbox, logger: unstubbed<Services["logger"]>("logger", { warn: () => {} }) }),
    };
};

test("a Visitor chat origin queues the reply for its own visitor and reports it delivered", async () => {
    const { outbox, services } = harness();
    const outcome = await deliverToListenerChannel(
        services,
        { automationId: "guest", provider: "webchat", channelId: "visitor-1" },
        "answered by a person",
    );

    expect(outcome).toBe("delivered");
    expect((await outbox.since("webchat:guest:visitor-1", 0, Date.now())).replies).toMatchObject([{ text: "answered by a person" }]);
    // Another visitor's thread is untouched: the channel id is the whole address.
    expect((await outbox.since("webchat:guest:visitor-2", 0, Date.now())).replies).toEqual([]);
});

test("an origin with no channel has nowhere to deliver, and says so rather than reaching for a gateway", async () => {
    // A webhook wake carries the automation but no thread; `unstubbed` would throw if the extension walk were reached.
    const { services } = harness();
    expect(await deliverToListenerChannel(services, { automationId: "guest", provider: "webchat" }, "hello")).toBe("no-gateway");
});

// A gateway's 200 says the message went; today's runtime adds a link to it as JSON, an older gateway answers a bare "ok".
test("a delivered message's link is passed on when the gateway names one, and its absence is not a failure", () => {
    expect(gatewayDeliveryOf(`{"url":"https://discord.com/channels/1/2/3"}`)).toEqual({ url: "https://discord.com/channels/1/2/3" });
    expect(gatewayDeliveryOf("{}")).toEqual({});
    expect(gatewayDeliveryOf("ok")).toEqual({});
    expect(gatewayDeliveryOf(`{"url":42}`)).toEqual({});
});

// An approved hold answers where the request came from: the stream that carried it closed when it was held, so the sink
// gathers the turn's words and posts them whole through the channel's own delivery once the turn ends. A Visitor chat
// origin stands in for a gateway here: both go through deliverToListenerChannel, and only the outbox needs no gateway.

const heldOrigin = { automationId: "guest", provider: "webchat", channelId: "visitor-1", threadId: "t1" };

test("the approved turn's words are posted once, whole, when it ends", async () => {
    const { outbox, services } = harness();
    const sink = channelAnswerSink(services, heldOrigin);
    sink?.stream.delta("Here is ");
    sink?.stream.delta("the answer.");
    expect((await outbox.since("webchat:guest:visitor-1", 0, Date.now())).replies).toEqual([]);
    sink?.stream.end();
    await sink?.settled();
    expect((await outbox.since("webchat:guest:visitor-1", 0, Date.now())).replies).toMatchObject([{ text: "Here is the answer." }]);
});

test("a turn that failed says so instead of posting half an answer", async () => {
    const { outbox, services } = harness();
    const sink = channelAnswerSink(services, heldOrigin);
    sink?.stream.delta("Starting");
    sink?.stream.failed("the model provider refused the request");
    sink?.stream.end();
    await sink?.settled();
    expect((await outbox.since("webchat:guest:visitor-1", 0, Date.now())).replies).toMatchObject([{ text: "⚠️ the model provider refused the request" }]);
});

test("a turn with nothing to say posts nothing, and an origin with no channel gets no sink", async () => {
    const { outbox, services } = harness();
    const sink = channelAnswerSink(services, heldOrigin);
    sink?.stream.delta("   ");
    sink?.stream.end();
    await sink?.settled();
    expect((await outbox.since("webchat:guest:visitor-1", 0, Date.now())).replies).toEqual([]);
    expect(channelAnswerSink(services, { automationId: "hook", provider: "webhook" })).toBeUndefined();
    expect(channelAnswerSink(services, undefined)).toBeUndefined();
});
