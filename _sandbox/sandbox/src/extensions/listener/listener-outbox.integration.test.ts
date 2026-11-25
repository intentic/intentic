import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DELIVER_ID_FEATURE } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { AgentOrigin } from "@intentic/sandbox-contract/schemas/agent";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { opt } from "../../opt.js";
import { setListenerStatus } from "../../capabilities/status/listener-status.js";
import { GatewayDeliveryError, type GatewayFailure } from "./listener-deliver.js";
import {
    backoffAfter,
    channelAnswerSink,
    type DeliverToGateway,
    drainOwedReplies,
    FAILED_TRIES_MAX,
    givenUpBecause,
    OWED_TTL_MS,
    owedReplies,
    owedRepliesInFlight,
    oweToListenerChannel,
} from "./listener-outbox.js";

// The daemon's reply outbox: what no live stream carries to a gateway's channel is journalled first, tried, and tried
// again until the gateway takes it, under one id so a gateway that dedupes posts it once; what is given up is said.

type Appended = Parameters<Services["activity"]["append"]>[0];

interface Harness {
    readonly services: Services;
    readonly errors: () => unknown[];
    readonly activity: Appended[];
}

// A daemon over one history volume; a second one over the same root is the daemon after a restart.
const daemonOver = (historyRoot: string): Harness => {
    const error = jest.fn();
    const activity: Appended[] = [];
    const services = unstubbed<Services>("services", {
        config: unstubbed<Services["config"]>("config", { historyRoot }),
        // Only its identity is read: what keeps this daemon's drain apart from another's.
        automations: unstubbed<Services["automations"]>("automations", {}),
        activity: unstubbed<Services["activity"]>("activity", { append: async (event) => void activity.push(event) }),
        logger: unstubbed<Services["logger"]>("logger", { error, warn: () => {}, info: () => {} }),
    });
    // The message each error was logged with, after its fields.
    return { services, errors: () => error.mock.calls.map((call) => call[1]), activity };
};

const freshDaemon = (): Harness => daemonOver(mkdtempSync(join(tmpdir(), "listener-outbox-")));

const origin = (provider: string, channelId = "C1", threadId: string | undefined = "T1"): AgentOrigin => ({
    automationId: "a1",
    provider,
    channelId,
    ...opt("threadId", threadId),
});

interface Call {
    readonly channelId: string;
    readonly text: string;
    readonly id: string;
}

// A gateway answering each try from a script: a failure kind throws as deliverThroughGateway would, "ok" posts.
const gateway = (script: Array<GatewayFailure | "ok">) => {
    const calls: Call[] = [];
    const deliver: DeliverToGateway = async (_services, provider, channelId, text, _thread, id) => {
        calls.push({ channelId, text, id });
        const next = script.shift() ?? "ok";
        if (next !== "ok") {
            throw new GatewayDeliveryError(`the ${provider} gateway: ${next}`, next);
        }
        return {};
    };
    return { deliver, calls };
};

afterEach(() => {
    jest.useRealTimers();
});

test("a reply is journalled before it is tried, and leaves the outbox once the gateway takes it", async () => {
    const { services } = freshDaemon();
    const { deliver, calls } = gateway(["ok"]);
    expect(await oweToListenerChannel(services, origin("slack"), "the answer", deliver)).toBe("owed");
    await drainOwedReplies(services, deliver);
    expect(calls).toMatchObject([{ channelId: "C1", text: "the answer" }]);
    expect(await owedReplies(services)).toEqual([]);
});

test("a gateway that is down keeps the reply owed, and it goes on the next try under the same id", async () => {
    const { services } = freshDaemon();
    const { deliver, calls } = gateway(["unreachable", "ok"]);
    await oweToListenerChannel(services, origin("slack"), "the answer", deliver);
    await drainOwedReplies(services, deliver);
    const [owed] = await owedReplies(services);
    expect(owed).toMatchObject({ attempts: 1, text: "the answer" });
    expect(owed?.lastError).toContain("unreachable");

    // Not due yet: a pass before the backoff runs out leaves it alone.
    await drainOwedReplies(services, deliver);
    expect(calls).toHaveLength(1);

    jest.setSystemTime(Date.now() + backoffAfter(1) + 1);
    await drainOwedReplies(services, deliver);
    expect(calls).toHaveLength(2);
    expect(calls[1]?.id).toBe(calls[0]?.id);
    expect(await owedReplies(services)).toEqual([]);
});

test("replies to one place go in the order they were owed; another place does not wait on it", async () => {
    const { services } = freshDaemon();
    const { deliver, calls } = gateway(["unreachable", "ok", "ok", "ok"]);
    // The first owe tries at once and fails; the drains below are what this test reads.
    await oweToListenerChannel(services, origin("slack"), "first", deliver);
    await drainOwedReplies(services, deliver);
    await oweToListenerChannel(services, origin("slack"), "second", deliver);
    await oweToListenerChannel(services, origin("slack", "C2"), "elsewhere", deliver);
    await drainOwedReplies(services, deliver);
    expect(calls.map((call) => call.text)).toEqual(["first", "elsewhere"]);

    jest.setSystemTime(Date.now() + backoffAfter(1) + 1);
    await drainOwedReplies(services, deliver);
    expect(calls.map((call) => call.text)).toEqual(["first", "elsewhere", "first", "second"]);
    expect(await owedReplies(services)).toEqual([]);
});

test("a try that may have posted is tried again only through a gateway that posts one id once", async () => {
    const plain = freshDaemon();
    const once = gateway(["ambiguous"]);
    await oweToListenerChannel(plain.services, origin("discord-old"), "maybe posted", once.deliver);
    await drainOwedReplies(plain.services, once.deliver);
    expect(await owedReplies(plain.services)).toEqual([]);
    expect(plain.errors()).toEqual(["channel reply outbox: gave up on a reply the channel never took"]);

    setListenerStatus("discord-new", { connections: [], features: [DELIVER_ID_FEATURE] }, Date.now());
    const deduping = freshDaemon();
    const twice = gateway(["ambiguous", "ok"]);
    await oweToListenerChannel(deduping.services, origin("discord-new"), "maybe posted", twice.deliver);
    await drainOwedReplies(deduping.services, twice.deliver);
    expect(await owedReplies(deduping.services)).toHaveLength(1);
    jest.setSystemTime(Date.now() + backoffAfter(1) + 1);
    await drainOwedReplies(deduping.services, twice.deliver);
    expect(twice.calls).toHaveLength(2);
    expect(new Set(twice.calls.map((call) => call.id)).size).toBe(1);
    expect(await owedReplies(deduping.services)).toEqual([]);
});

test("a reply the gateway refuses is given up at once, and the activity feed says it never reached the channel", async () => {
    const { services, errors, activity } = freshDaemon();
    const { deliver } = gateway(["refused"]);
    await oweToListenerChannel(services, origin("slack"), "the answer", deliver);
    await drainOwedReplies(services, deliver);
    expect(await owedReplies(services)).toEqual([]);
    expect(errors()).toHaveLength(1);
    expect(activity).toMatchObject([{ provider: "slack", direction: "out", outcome: "error", channelId: "C1", content: "the answer" }]);
    expect(activity[0]?.error).toContain("refused");
});

test("a reply owed longer than a day is given up rather than posted as a stray", async () => {
    const { services, errors } = freshDaemon();
    const { deliver, calls } = gateway(["unreachable"]);
    await oweToListenerChannel(services, origin("slack"), "stale", deliver);
    await drainOwedReplies(services, deliver);
    jest.setSystemTime(Date.now() + OWED_TTL_MS + 1);
    await drainOwedReplies(services, deliver);
    expect(calls).toHaveLength(1);
    expect(await owedReplies(services)).toEqual([]);
    expect(errors()).toHaveLength(1);
});

test("what an earlier daemon owed is tried by the next one once its gate opens", async () => {
    const root = mkdtempSync(join(tmpdir(), "listener-outbox-"));
    const before = daemonOver(root);
    const down = gateway(["unreachable"]);
    await oweToListenerChannel(before.services, origin("slack"), "owed across a restart", down.deliver);
    await drainOwedReplies(before.services, down.deliver);

    const after = daemonOver(root);
    const left = await owedRepliesInFlight.read(after.services);
    expect(left.count).toBe(1);
    jest.setSystemTime(Date.now() + backoffAfter(1) + 1);
    // The boot's recovery drains with the real gateway door; the test drains with its own after it, as the timer would.
    const up = gateway(["ok"]);
    await drainOwedReplies(after.services, up.deliver);
    expect(up.calls).toMatchObject([{ text: "owed across a restart" }]);
    expect(await owedReplies(after.services)).toEqual([]);
});

test("a provider failing a post is tried a bounded number of times; refusals and unreachable gateways are not counted the same", () => {
    expect(givenUpBecause("failed", FAILED_TRIES_MAX - 1, false)).toBeUndefined();
    expect(givenUpBecause("failed", FAILED_TRIES_MAX, false)).toContain("failed it");
    expect(givenUpBecause("unreachable", 1_000, false)).toBeUndefined();
    expect(givenUpBecause("refused", 1, true)).toContain("refused");
    expect(backoffAfter(1)).toBeLessThan(backoffAfter(4));
    expect(backoffAfter(50)).toBe(backoffAfter(60));
});

test("a held wake's answer is owed to its channel's thread once the turn ends", async () => {
    const { services } = freshDaemon();
    const sink = channelAnswerSink(services, origin("telegram", "chat-9", "42"));
    sink?.stream.delta("Here is ");
    sink?.stream.delta("the answer.");
    sink?.stream.end();
    await sink?.settled();
    // The real gateway door finds no extension here, which leaves the reply owed rather than lost.
    expect(await owedReplies(services)).toMatchObject([{ provider: "telegram", channelId: "chat-9", thread: "42", text: "Here is the answer." }]);
});
