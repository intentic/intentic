import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { deliverToListenerChannel, gatewayDeliveryOf } from "./listener-deliver.js";
import { channelAnswerSink, owedReplies } from "./listener-outbox.js";

// The core-door half of "speak as the agent", and the sink a held wake's answer is gathered in. (2026-11-26) A Visitor
// chat's reply goes through its extension's gateway like any channel's; the daemon kept the visitor's outbox itself
// until then, which these tests used to stand in for a gateway.

const harness = () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "listener-deliver-"));
    return {
        services: unstubbed<Services>("services", {
            config: unstubbed<Services["config"]>("config", { historyRoot }),
            // Only its identity is read: what keeps this daemon's drain apart from another's.
            automations: unstubbed<Services["automations"]>("automations", {}),
            activity: unstubbed<Services["activity"]>("activity", { append: async () => {} }),
            logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {}, info: () => {} }),
        }),
    };
};

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
// gathers the turn's words and owes them whole to the channel's gateway once the turn ends. No extension listens here,
// so what is owed stays owed, which is what these read.

const heldOrigin = { automationId: "guest", provider: "webchat", channelId: "visitor-1", threadId: "guest.0" };

test("the approved turn's words are owed once, whole, when it ends", async () => {
    const { services } = harness();
    const sink = channelAnswerSink(services, heldOrigin);
    sink?.stream.delta("Here is ");
    sink?.stream.delta("the answer.");
    expect(await owedReplies(services)).toEqual([]);
    sink?.stream.end();
    await sink?.settled();
    expect(await owedReplies(services)).toMatchObject([{ provider: "webchat", channelId: "visitor-1", thread: "guest.0", text: "Here is the answer." }]);
});

test("a turn that failed says so instead of posting half an answer", async () => {
    const { services } = harness();
    const sink = channelAnswerSink(services, heldOrigin);
    sink?.stream.delta("Starting");
    sink?.stream.failed("the model provider refused the request");
    sink?.stream.end();
    await sink?.settled();
    expect(await owedReplies(services)).toMatchObject([{ text: "⚠️ the model provider refused the request" }]);
});

test("a turn with nothing to say owes nothing, and an origin with no channel gets no sink", async () => {
    const { services } = harness();
    const sink = channelAnswerSink(services, heldOrigin);
    sink?.stream.delta("   ");
    sink?.stream.end();
    await sink?.settled();
    expect(await owedReplies(services)).toEqual([]);
    expect(channelAnswerSink(services, { automationId: "hook", provider: "webhook" })).toBeUndefined();
    expect(channelAnswerSink(services, undefined)).toBeUndefined();
});
