import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Automation } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import type { Services } from "../composition.js";
import { fileAutomationsStore } from "./automations-store.js";
import {
    createListeners,
    createMessageBatcher,
    dispatchListenerMessage,
    type ListenerMessage,
    type ListenerSource,
    type ListenerState,
    reportListenerFailure,
} from "./listeners.js";
import { PAYLOAD_MAX, type WakeFn } from "./scheduler.js";

// The listener paths touch automations/capabilities/activity/workspace/logger; a cast keeps the fake that small.
const fakeServices = (root: string): Services =>
    ({
        automations: fileAutomationsStore(join(root, "automations.json")),
        capabilities: fileCapabilitiesStore(join(root, "capabilities.json")),
        activity: { append: async () => {}, list: async () => [] },
        workspace: { root },
        logger: { error: () => {}, warn: () => {} },
    }) as unknown as Services;

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

test("a burst debounces into exactly one fire carrying every line", async () => {
    const fired: string[] = [];
    const batcher = createMessageBatcher(
        async (payload) => void fired.push(payload),
        () => {},
        5,
    );
    batcher.push("a");
    batcher.push("b");
    batcher.push("c");
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
    batcher.push("a");
    await vi.waitFor(() => expect(fired).toHaveLength(1));
    batcher.push("b");
    batcher.push("c");
    // Past the debounce, but the first fire is still running — nothing new fires yet.
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fired).toHaveLength(1);
    gate.resolve();
    await vi.waitFor(() => expect(fired).toHaveLength(2));
    expect(fired[1]).toBe("b\nc");
});

test("an over-cap batch keeps the newest whole lines within the payload cap", async () => {
    const fired: string[] = [];
    const batcher = createMessageBatcher(
        async (payload) => void fired.push(payload),
        () => {},
        5,
    );
    batcher.push(longLine("old"));
    batcher.push(longLine("mid"));
    batcher.push(longLine("new"));
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

test("the reconciler hands each source its enabled listener automations plus the capabilities, and stop stops sources", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "listen-")));
    await services.automations.upsert(listenerAutomation("live"));
    await services.automations.upsert(listenerAutomation("off", { enabled: false }));
    await services.automations.upsert({ id: "cron", trigger: { kind: "schedule", cron: "* * * * *" }, prompt: "p", enabled: true });
    await services.capabilities.upsert({ id: "discord", kind: "cli", config: { provider: "discord", botToken: "T" } });
    const seen: ListenerState[] = [];
    const stop = vi.fn();
    const source: ListenerSource = { provider: "discord", ensure: async (state) => void seen.push(state), stop };
    const listeners = createListeners(services, [source]);
    await listeners.ensure();
    expect(seen[0]?.automations.map((automation) => automation.id)).toEqual(["live"]);
    expect(seen[0]?.capabilities.map((capability) => capability.id)).toEqual(["discord"]);
    listeners.stop();
    expect(stop).toHaveBeenCalledOnce();
});
