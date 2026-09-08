import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentTurn, type Automation, SandboxSettingsSchema, type ListenerMessage } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { fileTurnJournal } from "../agent/run/turn/turn-journal.js";
import type { Services } from "../composition.js";
import { CHANNEL_SESSION_TTL_MS, fileThreadSessionsStore, threadKey } from "../sessions/thread-sessions.js";
import { unstubbed } from "@intentic/testing";
import { fileAutomationsStore } from "./automations-store.js";
import { createMessageBatcher, dispatchListenerMessage, type MessageContext, reportListenerFailure } from "./listeners.js";
import { PAYLOAD_MAX, type TurnStream, type WakeFn } from "./scheduler.js";

// The listener paths touch automations/capabilities/activity/workspace/logger; `unstubbed` keeps the fake small.
const fakeServices = (root: string): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        capabilities: fileCapabilitiesStore(join(root, "capabilities.json")),
        threadSessions: fileThreadSessionsStore(join(root, "thread-sessions.json")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });

const fakeWake = (prompts: string[]): WakeFn =>
    async function* (_services, input) {
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

// Waits with `SETTLES` rather than vitest's 1s default: an integration fire writes to a temp tree before its wake
// lands. Still finite, so a real regression fails on the assertion instead of hanging.
const eventually = (assertion: () => void | Promise<void>): Promise<void> => vi.waitFor(assertion, SETTLES);

// Fixed origin/title for every push; only the stream varies, since the batching tests are about payloads and reply
// sinks.
const context = (stream?: TurnStream): MessageContext => ({
    origin: { automationId: "a", provider: "discord", channelId: "c1", author: "alice" },
    title: "alice: hi",
    thread: threadKey("discord", "a", "c1"),
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
    await dispatchListenerMessage(services, message(), fakeWake(prompts), 5);
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
    const capture: WakeFn = async function* (_services, input) {
        turns.push(input);
        yield { kind: "done" };
    };
    await dispatchListenerMessage(services, message({ content: "can you look at the build?\nthanks" }), capture, 5);
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
const captureWithSession = (turns: AgentTurn[], sessionId: string): WakeFn =>
    async function* (_services, input) {
        turns.push(input);
        yield { kind: "session", sessionId };
        yield { kind: "done" };
    };

// A turn reaching the wake hasn't settled yet; the fire settles the thread record (session, lastAt) after. Callers that
// read or rewrite that record must wait for the settle first, or overwrite what they wrote.
const settledThread = async (services: Services, key: string): Promise<void> => {
    await eventually(async () => expect((await services.threadSessions.get(key, CHANNEL_SESSION_TTL_MS, Date.now()))?.sessionId).toEqual(expect.any(String)));
};

test("a follow-up message in the same channel reuses the conversation and resumes its session", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    // Distinct id per test: the batcher map is a singleton keyed by automation id; reuse reuses the prior batcher.
    await services.automations.upsert(listenerAutomation("thread-follow-up"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(services, message(), captureWithSession(turns, "sess-1"), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    // Session to resume is set once the first turn settles; an earlier follow-up would have nothing to resume.
    await settledThread(services, threadKey("discord", "thread-follow-up", "c1"));
    await dispatchListenerMessage(services, message({ id: "m2", content: "and one more thing" }), captureWithSession(turns, "sess-1"), 5);
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
    await dispatchListenerMessage(services, message(), captureWithSession(turns, "sess-1"), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    await dispatchListenerMessage(services, message({ id: "m2", channelId: "c2" }), captureWithSession(turns, "sess-2"), 5);
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
    await dispatchListenerMessage(services, message(), captureWithSession(turns, "sess-1"), 5);
    await eventually(() => expect(turns).toHaveLength(1));
    // Ages the record on disk rather than mocking the clock; must wait for the settle write before rewriting it.
    const key = threadKey("discord", "thread-ttl", "c1");
    await settledThread(services, key);
    const path = join(root, "thread-sessions.json");
    const aged = JSON.parse(readFileSync(path, "utf8")) as Record<string, { lastAt: number }>;
    (aged[key] as { lastAt: number }).lastAt = Date.now() - CHANNEL_SESSION_TTL_MS - 1;
    writeFileSync(path, JSON.stringify(aged));

    await dispatchListenerMessage(services, message({ id: "m2", content: "new topic" }), captureWithSession(turns, "sess-2"), 5);
    await eventually(() => expect(turns).toHaveLength(2));
    const [first, second] = turns as [AgentTurn, AgentTurn];
    expect(second.conversationId).not.toBe(first.conversationId);
    expect(second.sessionId).toBeUndefined();
});

test("dispatch honors eventType: a message-only listener ignores voice transcripts but fires on messages", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("msg-only", { trigger: { kind: "listener", provider: "discord", eventType: "message" } }));
    const prompts: string[] = [];
    await dispatchListenerMessage(services, message({ type: "voice_transcript", id: "v1" }), fakeWake(prompts), 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await services.automations.get("msg-only"))?.runs).toEqual([]);
    await dispatchListenerMessage(services, message(), fakeWake(prompts), 5);
    await eventually(async () => expect((await services.automations.get("msg-only"))?.runs).toHaveLength(1));
});

test("dispatch honors mentioned: a mention-only listener skips plain messages and fires on mentions", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(
        listenerAutomation("mentions", { trigger: { kind: "listener", provider: "discord", eventType: "message", mentioned: true } }),
    );
    const prompts: string[] = [];
    await dispatchListenerMessage(services, message(), fakeWake(prompts), 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await services.automations.get("mentions"))?.runs).toEqual([]);
    await dispatchListenerMessage(services, message({ id: "m2", mentioned: true }), fakeWake(prompts), 5);
    await eventually(async () => expect((await services.automations.get("mentions"))?.runs).toHaveLength(1));
});

test("a fatal source failure lands as an error run on the provider's listener automations only", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("live"));
    await services.automations.upsert({ id: "cron", trigger: { kind: "schedule", cron: "* * * * *" }, prompt: "p", models: [{ provider: "claude", model: "claude-sonnet-4-6" }], enabled: true });
    await reportListenerFailure(services, "discord", "Discord rejected the bot token");
    expect((await services.automations.get("live"))?.runs[0]).toMatchObject({ outcome: "error" });
    expect((await services.automations.get("live"))?.runs[0]?.detail).toContain("Discord");
    expect((await services.automations.get("live"))?.runs[0]?.detail).toContain("token");
    expect((await services.automations.get("cron"))?.runs).toEqual([]);
});
