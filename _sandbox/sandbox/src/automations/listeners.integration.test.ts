import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTurn, type Automation, SandboxSettingsSchema, type ListenerMessage } from "@intentic/sandbox-contract";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import type { z } from "zod";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { sqliteTurnJournal } from "../agent/run/turn/turn-journal.js";
import { conversationsDbPath, openConversationsDb } from "../store/conversations-db.js";
import type { Services } from "../composition.js";
import { CHANNEL_SESSION_TTL_MS, fileThreadSessionsStore, THREAD_SESSION_TTL_MS } from "../sessions/thread-sessions.js";
import { threadKey } from "../seams/thread-key.js";
import { unstubbed } from "@intentic/testing";
import { fileAutomationsStore } from "./automations-store.js";
import { fileHeldWakesStore } from "./held-wakes-store.js";
import { admittedUnheld, createMessageBatcher, dispatchListenerMessage, LISTENER_RATE_MAX, type MessageContext, reportListenerFailure } from "./listeners.js";
import { PAYLOAD_MAX, type TurnStream } from "./scheduler.js";
import { fileSendersStore } from "./senders-store.js";
import type { TurnStarter } from "../seams/turn-starter.js";
import { drivenBy } from "../testing.js";
import { opt } from "../opt.js";

// The listener paths touch automations/capabilities/activity/workspace/logger, the senders roster, and on a hold the
// held-wakes queue and push; `unstubbed` keeps the fake small.
const fakeServices = (root: string, settings: z.input<typeof SandboxSettingsSchema> = {}): Services =>
    unstubbed<Services>("services", {
        // No conversation here is on record, so a thread resumes the session it kept (routing.ts sessionFor).
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined }),
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse(settings) }),
        capabilities: fileCapabilitiesStore(join(root, "capabilities.json")),
        threadSessions: fileThreadSessionsStore(join(root, "thread-sessions.json"), () => false),
        senders: fileSendersStore(join(root, "senders.json")),
        heldWakes: fileHeldWakesStore(join(root, "history")),
        pushSender: unstubbed<Services["pushSender"]>("pushSender", { notifyIfAway: async () => ({ delivered: 0, failed: 0 }) }),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });

const fakeWake = (prompts: string[]): TurnStarter["stream"] =>
    async function* (input) {
        prompts.push(input.prompt);
        yield { kind: "done" };
    };

const listenerAutomation = (id: string, extra: Partial<Automation> = {}): Automation => ({
    id,
    trigger: { kind: "listener", provider: "discord" },
    prompt: `wake:${id}`,
    models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
    enabled: true,
    ...extra,
});

const message = (over: Partial<ListenerMessage> = {}): ListenerMessage => ({
    provider: "discord",
    type: "message",
    id: "m1",
    channelId: "c1",
    author: { id: "u1", name: "alice" },
    content: "hi",
    timestamp: "2026-07-03T00:00:00.000Z",
    ...over,
});

const longLine = (tag: string): string => tag + "x".repeat(30_000);

// Waits with `SETTLES` rather than waitFor's 1s default: an integration fire writes to a temp tree before its wake
// lands. Still finite, so a real regression fails on the assertion instead of hanging.
const eventually = (assertion: () => void | Promise<void>): Promise<void> => waitFor(assertion, SETTLES);

// Fixed origin/title for every push; only the stream varies, since the batching tests are about payloads and reply
// sinks.
const context = (stream?: TurnStream): MessageContext => ({
    origin: { automationId: "a", provider: "discord", channelId: "c1", author: "alice" },
    title: "alice: hi",
    thread: threadKey("discord", "a", "c1"),
    ttlMs: CHANNEL_SESSION_TTL_MS,
    lane: { actsAs: undefined, requireApproval: false },
    ...(stream !== undefined ? { stream } : {}),
});

test("a burst debounces into exactly one fire carrying every line", async () => {
    const fired: string[] = [];
    const batcher = createMessageBatcher(
        async (payload) => void fired.push(payload),
        () => {},
        5,
    );
    batcher.push("a", context());
    batcher.push("b", context());
    batcher.push("c", context());
    await eventually(() => expect(fired).toHaveLength(1));
    expect(fired[0]).toBe("a\nb\nc");
});

test("lines arriving during an in-flight run queue into one follow-up fire, nothing dropped", async () => {
    const gate = Promise.withResolvers<void>();
    const fired: string[] = [];
    const batcher = createMessageBatcher(
        async (payload) => {
            fired.push(payload);
            if (fired.length === 1) {
                await gate.promise;
            }
        },
        () => {},
        5,
    );
    batcher.push("a", context());
    await eventually(() => expect(fired).toHaveLength(1));
    batcher.push("b", context());
    batcher.push("c", context());
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fired).toHaveLength(1);
    gate.resolve();
    await eventually(() => expect(fired).toHaveLength(2));
    expect(fired[1]).toBe("b\nc");
});

test("a superseded reply stream is ended so a streamed dispatch never hangs on it", async () => {
    const ended: string[] = [];
    const s1: TurnStream = { delta: () => {}, failed: () => {}, end: () => void ended.push("s1") };
    const s2: TurnStream = { delta: () => {}, failed: () => {}, end: () => void ended.push("s2") };
    const fired: Array<TurnStream | undefined> = [];
    const batcher = createMessageBatcher(
        async (_payload, fireContext) => void fired.push(fireContext.stream),
        () => {},
        5,
    );
    batcher.push("a", context(s1));
    batcher.push("b", context(s2));
    expect(ended).toEqual(["s1"]);
    await eventually(() => expect(fired).toHaveLength(1));
    expect(fired[0]).toBe(s2);
});

test("an over-cap batch keeps the newest whole lines within the payload cap", async () => {
    const fired: string[] = [];
    const batcher = createMessageBatcher(
        async (payload) => void fired.push(payload),
        () => {},
        5,
    );
    batcher.push(longLine("old"), context());
    batcher.push(longLine("mid"), context());
    batcher.push(longLine("new"), context());
    await eventually(() => expect(fired).toHaveLength(1));
    // 3 × ~30k > PAYLOAD_MAX: the oldest line drops whole, never a mid-JSON slice.
    expect(fired[0]).toBe(`${longLine("mid")}\n${longLine("new")}`);
    expect((fired[0] as string).length).toBeLessThanOrEqual(PAYLOAD_MAX);
});

test("dispatch routes by provider and channelId and wakes with the JSON line as the event payload", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("all-channels"));
    await services.automations.upsert(listenerAutomation("one-channel", { trigger: { kind: "listener", provider: "discord", channelId: "c2" } }));
    await services.automations.upsert(listenerAutomation("off", { enabled: false }));
    const prompts: string[] = [];
    await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message(), 5);
    await eventually(async () => expect((await services.automations.get("all-channels"))?.runs).toHaveLength(1));
    // JSON payload rides sealed byte-identical inside the untrusted-content envelope.
    const sealed =
        /^wake:all-channels\n\n--- Event payload ---\n<untrusted-content source="discord" id="([0-9a-f]{16})">\n([\s\S]*)\n<\/untrusted-content id="\1">$/.exec(
            prompts[0] ?? "",
        );
    expect(sealed?.[2]).toBe(JSON.stringify(message()));
    expect((await services.automations.get("one-channel"))?.runs).toEqual([]);
    expect((await services.automations.get("off"))?.runs).toEqual([]);
});

test("a dispatched message opens an isolated conversation stamped with where it came from", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("support"));
    const turns: AgentTurn[] = [];
    const capture: TurnStarter["stream"] = async function* (input) {
        turns.push(input);
        yield { kind: "done" };
    };
    await dispatchListenerMessage(drivenBy(services, capture), message({ content: "can you look at the build?\nthanks" }), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    const turn = turns[0] as AgentTurn;
    expect(turn.isolated).toBe(true);
    expect(turn.conversationId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    expect(turn.origin).toEqual({ automationId: "support", provider: "discord", channelId: "c1", author: "alice" });
    // Titled by the message's first line, not the automation's prompt, since every fire shares that prompt.
    expect(turn.title).toBe("alice: can you look at the build?");
});

// Threading: a channel is one continuous conversation, not a series of strangers.

// A wake that also mints a provider session, so the next fire has something to resume.
const captureWithSession = (turns: AgentTurn[], sessionId: string): TurnStarter["stream"] =>
    async function* (input) {
        turns.push(input);
        yield { kind: "session", sessionId };
        yield { kind: "done" };
    };

// A turn reaching the wake hasn't settled yet; the fire settles the thread record (session, lastAt) after. Callers that
// read or rewrite that record must wait for the settle first, or overwrite what they wrote.
const settledThread = async (services: Services, key: string): Promise<void> => {
    await eventually(async () =>
        expect((await services.threadSessions.get(key, CHANNEL_SESSION_TTL_MS, Date.now()))?.sessionId).toEqual(expect.any(String)),
    );
};

test("a follow-up message in the same channel reuses the conversation and resumes its session", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    // Distinct id per test: the batcher map is a singleton keyed by automation id; reuse reuses the prior batcher.
    await services.automations.upsert(listenerAutomation("thread-follow-up"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-1")), message(), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    // Session to resume is set once the first turn settles; an earlier follow-up would have nothing to resume.
    await settledThread(services, threadKey("discord", "thread-follow-up", "c1"));
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-1")), message({ id: "m2", content: "and one more thing" }), 5);
    await eventually(() => expect(turns).toHaveLength(2));
    const [first, second] = turns as [AgentTurn, AgentTurn];
    expect(second.conversationId).toBe(first.conversationId);
    expect(first.sessionId).toBeUndefined();
    expect(second.sessionId).toBe("sess-1");
});

test("two channels of one automation get two conversations", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("thread-two-channels"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-1")), message(), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-2")), message({ id: "m2", channelId: "c2" }), 5);
    await eventually(() => expect(turns).toHaveLength(2));
    const [first, second] = turns as [AgentTurn, AgentTurn];
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(second.sessionId).toBeUndefined();
});

test("a channel quiet past the TTL starts a fresh conversation on the next message", async () => {
    const root = mkdtempSync(join(tmpdir(), "listen-"));
    const services = fakeServices(root);
    await services.automations.upsert(listenerAutomation("thread-ttl"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-1")), message(), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    // Ages the record on disk rather than mocking the clock; must wait for the settle write before rewriting it.
    const key = threadKey("discord", "thread-ttl", "c1");
    await settledThread(services, key);
    const path = join(root, "thread-sessions.json");
    const aged = JSON.parse(readFileSync(path, "utf8")) as Record<string, { lastAt: number }>;
    (aged[key] as { lastAt: number }).lastAt = Date.now() - CHANNEL_SESSION_TTL_MS - 1;
    writeFileSync(path, JSON.stringify(aged));

    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-2")), message({ id: "m2", content: "new topic" }), 5);
    await eventually(() => expect(turns).toHaveLength(2));
    const [first, second] = turns as [AgentTurn, AgentTurn];
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(second.sessionId).toBeUndefined();
});

test("dispatch honors eventType: a message-only listener ignores voice transcripts but fires on messages", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("msg-only", { trigger: { kind: "listener", provider: "discord", eventType: "message" } }));
    const prompts: string[] = [];
    await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message({ type: "voice_transcript", id: "v1" }), 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await services.automations.get("msg-only"))?.runs).toEqual([]);
    await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message(), 5);
    await eventually(async () => expect((await services.automations.get("msg-only"))?.runs).toHaveLength(1));
});

test("dispatch honors mentioned: a mention-only listener skips plain messages and fires on mentions", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(
        listenerAutomation("mentions", { trigger: { kind: "listener", provider: "discord", eventType: "message", mentioned: true } }),
    );
    const prompts: string[] = [];
    await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message(), 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await services.automations.get("mentions"))?.runs).toEqual([]);
    await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message({ id: "m2", mentioned: true }), 5);
    await eventually(async () => expect((await services.automations.get("mentions"))?.runs).toHaveLength(1));
});

test("a fatal source failure lands as an error run on the provider's listener automations only", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("live"));
    await services.automations.upsert({
        id: "cron",
        trigger: { kind: "schedule", cron: "* * * * *" },
        prompt: "p",
        models: [{ provider: "claude", model: "claude-sonnet-4-6" }],
        enabled: true,
    });
    await reportListenerFailure(services, "discord", "Discord rejected the bot token");
    expect((await services.automations.get("live"))?.runs[0]).toMatchObject({ outcome: "error" });
    expect((await services.automations.get("live"))?.runs[0]?.detail).toContain("Discord");
    expect((await services.automations.get("live"))?.runs[0]?.detail).toContain("token");
    expect((await services.automations.get("cron"))?.runs).toEqual([]);
});

// Sender rules: who a listener answers, and as whom. The people in one channel are not one caller.

const mark = { id: "u-mark", name: "Mark" };
const martha = { id: "u-martha", name: "Martha" };

// The owner's front line: Mark gets the unpinned agent, Martha the guest persona, nobody else gets anything.
const frontLine = (id: string, extra: Partial<Automation> = {}): Automation =>
    listenerAutomation(id, {
        senders: { rules: [{ ids: [mark.id] }, { ids: [martha.id], actsAs: "customer-service" }], others: "ignore" },
        ...extra,
    });

test("a sender no rule names wakes nothing under `others: ignore`, and is still written to the roster", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(frontLine("senders-ignore"));
    const prompts: string[] = [];
    await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message(), 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(prompts).toEqual([]);
    expect((await services.automations.get("senders-ignore"))?.runs).toEqual([]);
    // Who tried is what the owner needs to name them next time.
    await eventually(async () => expect(await services.senders.list("discord")).toMatchObject([{ id: "u1", name: "alice", messages: 1 }]));
});

test("two people one channel answers as different agents get two conversations, each turn wearing its rule's persona", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(frontLine("senders-lanes"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-mark")), message({ author: mark, content: "deploy it" }), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    await settledThread(services, threadKey("discord", "senders-lanes", "c1"));
    await dispatchListenerMessage(
        drivenBy(services, captureWithSession(turns, "sess-martha")),
        message({ id: "m2", author: martha, content: "where is my order?" }),
        5,
    );
    await eventually(() => expect(turns).toHaveLength(2));
    const [first, second] = turns as [AgentTurn, AgentTurn];
    expect(first.actsAs).toBeUndefined();
    expect(second.actsAs).toBe("customer-service");
    // Martha's turn neither joins Mark's conversation nor resumes the session his unpinned turn left behind.
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(second.sessionId).toBeUndefined();
    await settledThread(services, threadKey("discord", "senders-lanes", "c1", "customer-service"));
});

test("a burst from two lanes becomes two wakes, neither carrying the other's line", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(frontLine("senders-burst"));
    const turns: AgentTurn[] = [];
    const capture: TurnStarter["stream"] = async function* (input) {
        turns.push(input);
        yield { kind: "done" };
    };
    // Inside one debounce window: without lanes these would coalesce into one payload under one persona.
    await dispatchListenerMessage(drivenBy(services, capture), message({ author: mark, content: "mark's line" }), 5);
    await dispatchListenerMessage(drivenBy(services, capture), message({ id: "m2", author: martha, content: "martha's line" }), 5);
    await eventually(() => expect(turns).toHaveLength(2));
    const byPersona = new Map(turns.map((turn) => [turn.actsAs, turn.prompt]));
    expect(byPersona.get(undefined)).toContain("mark's line");
    expect(byPersona.get(undefined)).not.toContain("martha's line");
    expect(byPersona.get("customer-service")).toContain("martha's line");
    expect(byPersona.get("customer-service")).not.toContain("mark's line");
});

test("a rule that holds its people parks the wake with the lane's persona and thread snapshotted, running nothing", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(
        listenerAutomation("senders-hold", {
            senders: { rules: [{ ids: ["u1"], actsAs: "guest", requireApproval: true }], others: "allow" },
        }),
    );
    const prompts: string[] = [];
    await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message(), 5);
    await eventually(async () => expect(await services.heldWakes.list()).toHaveLength(1));
    expect((await services.heldWakes.list())[0]).toMatchObject({
        automationId: "senders-hold",
        actsAs: "guest",
        thread: threadKey("discord", "senders-hold", "c1", "guest"),
        origin: { provider: "discord", channelId: "c1", author: "alice" },
    });
    expect(prompts).toEqual([]);
    expect((await services.automations.get("senders-hold"))?.runs).toEqual([]);
});

test("`others: hold` parks a stranger wearing the automation's own persona", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(
        listenerAutomation("senders-others-hold", { actsAs: "guest", senders: { rules: [{ ids: [mark.id] }], others: "hold" } }),
    );
    const prompts: string[] = [];
    await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message(), 5);
    await eventually(async () => expect(await services.heldWakes.list()).toHaveLength(1));
    expect((await services.heldWakes.list())[0]).toMatchObject({ automationId: "senders-others-hold", actsAs: "guest" });
    expect(prompts).toEqual([]);
});

// The contract calls an automation's allowlist the real boundary for anything a stranger's message drives; only
// webchat and intake used to carry it, so a channel message ran on the full toolbox.
test("a channel message wakes a turn narrowed to the automation's allowedTools", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("narrow-tools", { allowedTools: ["Read", "Grep"] }));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-narrow")), message(), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    expect(turns[0]?.allowedTools).toEqual(["Read", "Grep"]);
});

// A channel is a door strangers knock on too: one sender flooding it is turned away past the minute's limit rather
// than driving a wake per line.
test("a sender over the minute's limit is dropped, and another sender in the channel still gets through", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("flooded"));
    const prompts: string[] = [];
    const flood = { id: "u-flood", name: "flood" };
    for (let index = 0; index <= LISTENER_RATE_MAX; index += 1) {
        await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message({ id: `f${index}`, author: flood, content: `<${index}>` }), 5);
    }
    // However the batcher folded them into wakes, every line inside the limit arrived and the one past it did not.
    await eventually(() => expect(prompts.join("")).toContain(`<${LISTENER_RATE_MAX - 1}>`));
    expect(prompts.join("")).not.toContain(`<${LISTENER_RATE_MAX}>`);
    await dispatchListenerMessage(drivenBy(services, fakeWake(prompts)), message({ id: "other", author: { id: "u-other", name: "other" }, content: "<other>" }), 5);
    await eventually(() => expect(prompts.join("")).toContain("<other>"));
});

// Provider threads: a Discord or Slack thread is one topic, so it is one conversation of its own, kept for days.

test("a message in a provider thread opens its own conversation, apart from the channel's and from other threads", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("threads-apart"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-t1")), message({ thread: "t1", mentioned: true }), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-t2")), message({ id: "m2", thread: "t2", mentioned: true }), 5);
    await eventually(() => expect(turns).toHaveLength(2));
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-c1")), message({ id: "m3" }), 5);
    await eventually(() => expect(turns).toHaveLength(3));
    expect(new Set(turns.map((turn) => turn.conversationId)).size).toBe(3);
    // What is said back between turns goes into the thread: the origin names it beside its channel.
    expect(turns[0]?.origin).toEqual({ automationId: "threads-apart", provider: "discord", channelId: "c1", threadId: "t1", author: "alice" });
    expect(turns[2]?.origin).toEqual({ automationId: "threads-apart", provider: "discord", channelId: "c1", author: "alice" });
});

test("a thread keeps its conversation past a channel's quiet limit, and resumes its session", async () => {
    const root = mkdtempSync(join(tmpdir(), "listen-"));
    const services = fakeServices(root);
    await services.automations.upsert(listenerAutomation("thread-week"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-1")), message({ thread: "t1" }), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    const key = threadKey("discord", "thread-week", "c1/t1");
    await eventually(async () => expect((await services.threadSessions.get(key, THREAD_SESSION_TTL_MS, Date.now()))?.sessionId).toBe("sess-1"));
    // Quiet for longer than a channel keeps its conversation, well inside a thread's week.
    const path = join(root, "thread-sessions.json");
    // SAFETY: the thread-sessions document is a record of thread records, each with its lastAt, as the store wrote it.
    const aged = JSON.parse(readFileSync(path, "utf8")) as Record<string, { lastAt: number }>;
    writeFileSync(path, JSON.stringify({ ...aged, [key]: { ...aged[key], lastAt: Date.now() - CHANNEL_SESSION_TTL_MS - 60_000 } }));
    await dispatchListenerMessage(drivenBy(services, captureWithSession(turns, "sess-1")), message({ id: "m2", thread: "t1", content: "picking this back up" }), 5);
    await eventually(() => expect(turns).toHaveLength(2));
    expect(turns[1]?.conversationId).toBe(turns[0]?.conversationId);
    expect(turns[1]?.sessionId).toBe("sess-1");
});

// A wake that holds its turn open until released, so a test can speak to it while it runs.
const heldOpen = (turns: AgentTurn[], release: Promise<void>): TurnStarter["stream"] =>
    async function* (input) {
        turns.push(input);
        yield { kind: "session", sessionId: `sess-${turns.length}` };
        await release;
        yield { kind: "done" };
    };

// The services with the live turn's door for mid-run words replaced: what was steered, and whether the turn takes it.
const steeringInto = (services: Services, steers: Array<{ conversationId: string; text: string; outside?: string }>, takes: boolean): Services =>
    unstubbed<Services>("services", {
        ...services,
        turns: {
            ...services.turns,
            steer: async (conversationId, steer) => {
                steers.push({ conversationId, text: steer.text, ...opt("outside", steer.outside) });
                return takes;
            },
        },
    });

// A reply sink that records what it heard, in order.
const recordingSink = (heard: string[]): TurnStream => ({
    delta: (text) => void heard.push(`delta:${text}`),
    failed: (reason) => void heard.push(`failed:${reason}`),
    steered: () => void heard.push("steered"),
    queued: () => void heard.push("queued"),
    end: () => void heard.push("end"),
});

test("a message for a thread whose turn is running goes into that turn, sealed as outside words, and starts nothing new", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("steer-live"));
    const turns: AgentTurn[] = [];
    const release = Promise.withResolvers<void>();
    const steers: Array<{ conversationId: string; text: string; outside?: string }> = [];
    const driven = steeringInto(drivenBy(services, heldOpen(turns, release.promise)), steers, true);
    await dispatchListenerMessage(driven, message({ thread: "t1", mentioned: true }), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    const heard: string[] = [];
    await dispatchListenerMessage(driven, message({ id: "m2", thread: "t1", mentioned: true, content: "also check the docs" }), 5, () => recordingSink(heard));
    await eventually(() => expect(heard).toEqual(["steered", "end"]));
    expect(steers).toHaveLength(1);
    expect(steers[0]?.conversationId).toBe(turns[0]?.conversationId);
    expect(steers[0]?.outside).toBe("discord");
    expect(steers[0]?.text).toContain('<untrusted-content source="discord"');
    expect(steers[0]?.text).toContain("also check the docs");
    release.resolve();
    await new Promise((resolve) => setTimeout(resolve, 40));
    // The running turn answered it; no second wake follows for the steered message.
    expect(turns).toHaveLength(1);
});

test("a message the running turn does not take waits, and fires on the same conversation once the turn ends", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("steer-refused"));
    const turns: AgentTurn[] = [];
    const release = Promise.withResolvers<void>();
    const steers: Array<{ conversationId: string; text: string }> = [];
    const driven = steeringInto(drivenBy(services, heldOpen(turns, release.promise)), steers, false);
    await dispatchListenerMessage(driven, message({ thread: "t1" }), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    await dispatchListenerMessage(driven, message({ id: "m2", thread: "t1", content: "one more" }), 5);
    await eventually(() => expect(steers).toHaveLength(1));
    expect(turns).toHaveLength(1);
    release.resolve();
    await eventually(() => expect(turns).toHaveLength(2));
    expect(turns[1]?.conversationId).toBe(turns[0]?.conversationId);
    expect(turns[1]?.prompt).toContain("one more");
});

test("a sender whose rule needs a person's release is never steered into a running turn; their message is held instead", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(
        listenerAutomation("steer-held-lane", { senders: { rules: [{ ids: [martha.id], requireApproval: true }], others: "allow" } }),
    );
    const turns: AgentTurn[] = [];
    const release = Promise.withResolvers<void>();
    const steers: Array<{ conversationId: string; text: string }> = [];
    const driven = steeringInto(drivenBy(services, heldOpen(turns, release.promise)), steers, true);
    await dispatchListenerMessage(driven, message({ thread: "t1", author: mark }), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    await dispatchListenerMessage(driven, message({ id: "m2", thread: "t1", author: martha, content: "run the migration" }), 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(steers).toEqual([]);
    release.resolve();
    await eventually(async () => expect(await services.heldWakes.list()).toHaveLength(1));
    expect(turns).toHaveLength(1);
});

test("two people mentioning the bot in two threads are answered side by side, neither told to wait", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("side-by-side"));
    const turns: AgentTurn[] = [];
    const release = Promise.withResolvers<void>();
    const driven = drivenBy(services, heldOpen(turns, release.promise));
    await dispatchListenerMessage(driven, message({ thread: "t1", mentioned: true }), 5);
    const heard: string[] = [];
    await dispatchListenerMessage(driven, message({ id: "m2", thread: "t2", mentioned: true, author: { id: "u2", name: "bob" } }), 5, () =>
        recordingSink(heard),
    );
    // Both turns are running before either is let go.
    await eventually(() => expect(turns).toHaveLength(2));
    expect(turns[1]?.conversationId).not.toBe(turns[0]?.conversationId);
    expect(heard).not.toContain("queued");
    release.resolve();
    await eventually(() => expect(heard).toContain("end"));
});

test("a thread beyond the sandbox's threads-at-once is told it is queued, and starts once a thread before it ends", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")), { automationThreadsAtOnce: 1 });
    await services.automations.upsert(listenerAutomation("queued-threads"));
    const turns: AgentTurn[] = [];
    const release = Promise.withResolvers<void>();
    const driven = drivenBy(services, heldOpen(turns, release.promise));
    await dispatchListenerMessage(driven, message({ thread: "t1", mentioned: true }), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    const heard: string[] = [];
    await dispatchListenerMessage(driven, message({ id: "m2", thread: "t2", mentioned: true }), 5, () => recordingSink(heard));
    await eventually(() => expect(heard).toContain("queued"));
    expect(turns).toHaveLength(1);
    release.resolve();
    await eventually(() => expect(turns).toHaveLength(2));
    expect(turns[1]?.conversationId).not.toBe(turns[0]?.conversationId);
});

test("only a message that would start a turn unreleased may go into a running one: the automation's hold, a countdown, the sandbox's floor, the lane's hold each keep it out", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    const free = { actsAs: undefined, requireApproval: false };
    await services.automations.upsert(listenerAutomation("admit-open"));
    await services.automations.upsert(listenerAutomation("admit-held", { requireApproval: true }));
    await services.automations.upsert(listenerAutomation("admit-countdown", { holdForSeconds: 60 }));
    await services.automations.upsert(listenerAutomation("admit-off", { enabled: false }));
    expect(await admittedUnheld(services, "admit-open", free)).toBe(true);
    expect(await admittedUnheld(services, "admit-open", { actsAs: undefined, requireApproval: true })).toBe(false);
    expect(await admittedUnheld(services, "admit-held", free)).toBe(false);
    expect(await admittedUnheld(services, "admit-countdown", free)).toBe(false);
    expect(await admittedUnheld(services, "admit-off", free)).toBe(false);
    expect(await admittedUnheld(services, "admit-gone", free)).toBe(false);
    const holdingListeners = unstubbed<Services>("services", {
        ...services,
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse({ admission: { listener: "hold" } }),
        }),
    });
    expect(await admittedUnheld(holdingListeners, "admit-open", free)).toBe(false);
});
