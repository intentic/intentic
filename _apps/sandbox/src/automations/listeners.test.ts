import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentTurn, Automation } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { fileTurnJournal } from "../agent/turn-journal.js";
import type { Services } from "../composition.js";
import { CHANNEL_SESSION_TTL_MS, fileThreadSessionsStore, threadKey } from "../sessions/thread-sessions.js";
import { unstubbed } from "../testing.js";
import { fileAutomationsStore } from "./automations-store.js";
import { createMessageBatcher, dispatchListenerMessage, type ListenerMessage, type MessageContext, reportListenerFailure } from "./listeners.js";
import { PAYLOAD_MAX, type TurnStream, type WakeFn } from "./scheduler.js";

// The listener paths touch automations/capabilities/activity/workspace/logger; `unstubbed` keeps the fake small.
const fakeServices = (root: string): Services =>
    unstubbed<Services>("services", {
        automations: fileAutomationsStore(join(root, "automations.json")),
        capabilities: fileCapabilitiesStore(join(root, "capabilities.json")),
        threadSessions: fileThreadSessionsStore(join(root, "thread-sessions.json")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], open: async () => {}, append: async () => {} }),
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

// The provenance every push carries — the batching rules under test are about payloads and reply sinks, so the
// origin/title are held constant and only the sink varies.
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
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    expect(fired[0]).toBe("a\nb\nc");
});

test("lines arriving during an in-flight run queue into one follow-up fire — nothing dropped", async () => {
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
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    batcher.push("b", context());
    batcher.push("c", context());
    // Past the debounce, but the first fire is still running — nothing new fires yet.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fired).toHaveLength(1);
    gate.resolve();
    await vi.waitFor(() => expect(fired).toHaveLength(2));
    expect(fired[1]).toBe("b\nc");
});

test("a superseded reply stream is ended so a streamed dispatch never hangs on it", async () => {
    const ended: string[] = [];
    const s1: TurnStream = { delta: () => {}, end: () => void ended.push("s1") };
    const s2: TurnStream = { delta: () => {}, end: () => void ended.push("s2") };
    const fired: Array<TurnStream | undefined> = [];
    const batcher = createMessageBatcher(
        async (_payload, fireContext) => void fired.push(fireContext.stream),
        () => {},
        5,
    );
    batcher.push("a", context(s1));
    batcher.push("b", context(s2));
    // s1 is replaced before any flush — it's ended immediately so its consumer isn't stranded; s2 survives.
    expect(ended).toEqual(["s1"]);
    await vi.waitFor(() => expect(fired).toHaveLength(1));
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
    await vi.waitFor(() => expect(fired).toHaveLength(1));
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
    await vi.waitFor(async () => expect((await services.automations.get("all-channels"))?.runs).toHaveLength(1));
    expect(prompts).toEqual([`wake:all-channels\n\n--- Event payload ---\n${JSON.stringify(message())}`]);
    // The c2-scoped automation and the disabled one never fired.
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
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    const turn = turns[0] as AgentTurn;
    expect(turn.isolated).toBe(true);
    expect(turn.conversationId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    expect(turn.origin).toEqual({ automationId: "support", provider: "discord", channelId: "c1", author: "alice" });
    // Titled by the message's first line, not by the automation's prompt — every fire shares that prompt, so a
    // prompt-derived title would give a board full of identical cards.
    expect(turn.title).toBe("alice: can you look at the build?");
});

/* ---- threading: the property that makes a channel a conversation rather than a series of strangers ---- */

// A wake that also mints a provider session, so the next fire has something to resume.
const captureWithSession = (turns: AgentTurn[], sessionId: string): WakeFn =>
    async function* (_services, input) {
        turns.push(input);
        yield { kind: "session", sessionId };
        yield { kind: "done" };
    };

test("a follow-up message in the same channel reuses the conversation and resumes its session", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    // A distinct id per test: the batcher map is a module singleton keyed by automation id, so a shared id
    // would hand this test the previous one's batcher — closed over ITS services and wake.
    await services.automations.upsert(listenerAutomation("thread-follow-up"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(services, message(), captureWithSession(turns, "sess-1"), 5);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await dispatchListenerMessage(services, message({ id: "m2", content: "and one more thing" }), captureWithSession(turns, "sess-1"), 5);
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    const [first, second] = turns as [AgentTurn, AgentTurn];
    // One card, one worktree, one agent that remembers — not a second stranger.
    expect(second.conversationId).toBe(first.conversationId);
    expect(first.sessionId).toBeUndefined();
    expect(second.sessionId).toBe("sess-1");
});

test("two channels of one automation get two conversations", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("thread-two-channels"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(services, message(), captureWithSession(turns, "sess-1"), 5);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    await dispatchListenerMessage(services, message({ id: "m2", channelId: "c2" }), captureWithSession(turns, "sess-2"), 5);
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    const [first, second] = turns as [AgentTurn, AgentTurn];
    expect(second.conversationId).not.toBe(first.conversationId);
    // #eng's thread must not resume #design's session.
    expect(second.sessionId).toBeUndefined();
});

test("a channel quiet past the TTL starts a fresh conversation on the next message", async () => {
    const root = mkdtempSync(join(tmpdir(), "listen-"));
    const services = fakeServices(root);
    await services.automations.upsert(listenerAutomation("thread-ttl"));
    const turns: AgentTurn[] = [];
    await dispatchListenerMessage(services, message(), captureWithSession(turns, "sess-1"), 5);
    await vi.waitFor(() => expect(turns).toHaveLength(1));
    // Age the record past the window instead of mocking the clock — the dispatcher's own TTL read is what's
    // under test, and the store is the only thing that carries "when was this channel last active".
    const path = join(root, "thread-sessions.json");
    const key = threadKey("discord", "thread-ttl", "c1");
    const aged = JSON.parse(readFileSync(path, "utf8")) as Record<string, { lastAt: number }>;
    (aged[key] as { lastAt: number }).lastAt = Date.now() - CHANNEL_SESSION_TTL_MS - 1;
    writeFileSync(path, JSON.stringify(aged));

    await dispatchListenerMessage(services, message({ id: "m2", content: "new topic" }), captureWithSession(turns, "sess-2"), 5);
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    const [first, second] = turns as [AgentTurn, AgentTurn];
    expect(second.conversationId).not.toBe(first.conversationId);
    // A stale thread is a fresh start, not a resume of a session whose subject moved on hours ago.
    expect(second.sessionId).toBeUndefined();
});

test("dispatch honors eventType — a message-only listener ignores voice transcripts but fires on messages", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("msg-only", { trigger: { kind: "listener", provider: "discord", eventType: "message" } }));
    const prompts: string[] = [];
    // A voice_transcript event must NOT wake a message-only listener.
    await dispatchListenerMessage(services, message({ type: "voice_transcript", id: "v1" }), fakeWake(prompts), 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await services.automations.get("msg-only"))?.runs).toEqual([]);
    // A message event does wake it.
    await dispatchListenerMessage(services, message(), fakeWake(prompts), 5);
    await vi.waitFor(async () => expect((await services.automations.get("msg-only"))?.runs).toHaveLength(1));
});

test("dispatch honors mentioned — a mention-only listener skips plain messages and fires on mentions", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(
        listenerAutomation("mentions", { trigger: { kind: "listener", provider: "discord", eventType: "message", mentioned: true } }),
    );
    const prompts: string[] = [];
    // A plain message must NOT wake a mention-only listener.
    await dispatchListenerMessage(services, message(), fakeWake(prompts), 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect((await services.automations.get("mentions"))?.runs).toEqual([]);
    // A message that tags the bot does wake it.
    await dispatchListenerMessage(services, message({ id: "m2", mentioned: true }), fakeWake(prompts), 5);
    await vi.waitFor(async () => expect((await services.automations.get("mentions"))?.runs).toHaveLength(1));
});

test("a fatal source failure lands as an error run on the provider's listener automations only", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("live"));
    await services.automations.upsert({ id: "cron", trigger: { kind: "schedule", cron: "* * * * *" }, prompt: "p", enabled: true });
    await reportListenerFailure(services, "discord", "Discord rejected the bot token");
    expect((await services.automations.get("live"))?.runs[0]).toMatchObject({ outcome: "error", detail: "Discord rejected the bot token" });
    expect((await services.automations.get("cron"))?.runs).toEqual([]);
});
