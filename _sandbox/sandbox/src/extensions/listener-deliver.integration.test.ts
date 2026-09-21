import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import type { Services } from "../composition.js";
import { fileWebchatOutbox } from "../webchat/webchat-outbox.js";
import { deliverToListenerChannel } from "./listener-deliver.js";

// The core-door half of "speak as the agent". A Visitor chat has no gateway extension and never will, so without this
// leg `place` on a visitor's conversation reported "nothing is listening" and the words reached only the transcript.

const harness = () => {
    const outbox = fileWebchatOutbox(join(mkdtempSync(join(tmpdir(), "listener-deliver-")), "outbox.json"));
    return { outbox, services: unstubbed<Services>("services", { webchatOutbox: outbox }) };
};

test("a Visitor chat origin queues the reply for its own visitor and reports it delivered", async () => {
    const { outbox, services } = harness();
    const outcome = await deliverToListenerChannel(services, { automationId: "guest", provider: "webchat", channelId: "visitor-1" }, "answered by a person");

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
