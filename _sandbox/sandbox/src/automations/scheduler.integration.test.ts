import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AgentTurn, type Automation, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT_EXCLUDE_ENV } from "@intentic/sandbox-contract/chores";
import { unstubbed } from "@intentic/testing";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import type { z } from "zod";
import { fileTurnJournal } from "../agent/run/turn/turn-journal.js";
import type { PersistedAgent } from "../agents/registry/agents-store.js";
import type { Services } from "../composition.js";
import { automationConfig } from "../harness/route-stores.testing.js";
import { fileHeldWakesStore } from "./held-wakes-store.js";
import { type AutomationRecord, fileAutomationsStore } from "./automations-store.js";
import { automationIdle, createAutomationsScheduler, fireAutomation, type WakeFn } from "./scheduler.js";

// Touches automations/heldWakes/activity/turnJournal/workspace/logger/sandboxSettings, plus liveSessionIds and registry
// entries (mutated in place); the journal is real, since its in-flight entry is asserted on.
const fakeServices = (
    root: string,
    settings: z.input<typeof SandboxSettingsSchema> = {},
    live: string[] = [],
    registry: readonly PersistedAgent[] = [],
): Services =>
    unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", {
            liveSessionIds: () => live,
            ids: () => registry.map((entry) => entry.id),
            entry: (id) => registry.find((entry) => entry.id === id),
        }),
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        // Guard defaults off from `{}`, the production default, unless a test opts in.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse(settings),
        }),
        heldWakes: fileHeldWakesStore(join(root, "approvals")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        activity: { append: async () => {}, list: async () => [] },
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        // No device subscribed, which is what a workspace that has never granted push reports.
        pushSender: unstubbed<Services["pushSender"]>("pushSender", { notifyIfAway: async () => ({ delivered: 0, failed: 0 }) }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {} }),
    });

// A fake wake that records complete turn identities; `events` lets a test surface an agent error.
const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }], turns: AgentTurn[] = []): WakeFn =>
    async function* (_services, input) {
        prompts.push(input.prompt);
        turns.push(input);
        yield* events;
    };

// One conversation as the registry holds it, with only what the sessions gate reads chosen: when it was
// opened, by whom (an origin, or a fire's `a-` name), and whether a turn ever ran in it.
const conversation = (id: string, createdAt: number, extra: Partial<PersistedAgent> = {}): PersistedAgent => ({
    id,
    title: id,
    provider: "claude",
    harness: "native",
    status: "idle",
    repos: [],
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    turns: 1,
    createdAt,
    updatedAt: createdAt,
    ...extra,
});

const gatedNightly = (id: string): Automation => automationConfig(id, { trigger: { kind: "schedule", cron: "* * * * *", afterSessions: 30 } });

const DAY = 86_400_000;

// Ticking 61s past construction guarantees an every-minute cron has exactly one occurrence in the window.
const pastDue = (): number => Date.now() + 61_000;

test("a due cron wakes the agent once and records a completed run", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("inbox"));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("inbox"))?.runs).toHaveLength(1), SETTLES);
    expect(prompts).toEqual(["wake:inbox"]);
    expect((await services.automations.get("inbox"))?.runs[0]?.outcome).toBe("completed");
});

test("a failing guard skips the wake and records why; a passing guard wakes", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("guarded", { guard: "echo nothing new; exit 1" }));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("guarded"))?.runs).toHaveLength(1), SETTLES);
    const skipped = (await services.automations.get("guarded"))?.runs[0];
    expect(skipped?.outcome).toBe("skipped");
    expect(skipped?.detail).toBe("nothing new");
    expect(prompts).toEqual([]);

    // Editing the guard keeps run history; the next due tick wakes and prepends a completed run.
    await automationIdle("guarded");
    await services.automations.upsert(automationConfig("guarded", { guard: "true" }));
    await scheduler.tick(pastDue() + 61_000);
    await vi.waitFor(async () => expect((await services.automations.get("guarded"))?.runs).toHaveLength(2), SETTLES);
    expect((await services.automations.get("guarded"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts).toEqual(["wake:guarded"]);
});

test("guards receive the reserved workspace-root directory to prune", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("scoped", { guard: `test "$${WORKSPACE_ROOT_EXCLUDE_ENV}" = "refs"` }));
    const prompts: string[] = [];
    await fireAutomation(services, (await services.automations.get("scoped")) as AutomationRecord, fakeWake(prompts));
    expect((await services.automations.get("scoped"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts).toEqual(["wake:scoped"]);
});

// Sessions gate (afterSessions): the one pre-wake check computed from the daemon's own registry, not a guard. Pins what
// counts, what's excluded, where "last time" is read from, and what the allowed wake is told.

test("a schedule gated on sessions skips short of the bar and says how far off it is; at the bar it wakes with the sessions under its prompt", async () => {
    const registry = Array.from({ length: 29 }, (_, index) => conversation(`swift-otter-${index}`, DAY + index));
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), {}, [], registry);
    await services.automations.upsert(gatedNightly("dream"));
    const prompts: string[] = [];
    const fire = async (): Promise<void> => {
        await fireAutomation(services, (await services.automations.get("dream")) as AutomationRecord, fakeWake(prompts));
    };

    await fire();
    expect((await services.automations.get("dream"))?.runs[0]).toMatchObject({ outcome: "skipped", detail: "29 of 30 sessions since the last wake" });
    expect(prompts).toEqual([]);

    registry.push(conversation("swift-otter-29", DAY + 29));
    await fire();
    expect((await services.automations.get("dream"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts[0]).toMatch(
        /^wake:dream\n\n--- Sessions since the last wake ---\n30 sessions and this automation has never woken an agent before\. Newest first:\nswift-otter-29 · swift-otter-29 · 1970-01-02T00:00:00\.029Z · 1 turns · 0 tool uses · \$0\.00\n/,
    );
    // The brief, a blank line, the heading, the count line, then one line per session.
    expect(prompts[0]?.split("\n")).toHaveLength(4 + 30);
});

test("last time is the conversation the last fire opened, and the fleet's own wakes and unturned conversations never count", async () => {
    const dreamedAt = 100 * DAY;
    const after = (index: number): number => dreamedAt + DAY + index;
    const registry = [
        conversation("a-dream-mabc", dreamedAt),
        // Id merely begins with "dream"'s: its own nights, not counted as dream's.
        conversation("a-dream-2-mabd", dreamedAt - 2 * DAY),
        // Predates the last wake: already reviewed, never counted again regardless of skips.
        ...Array.from({ length: 40 }, (_, index) => conversation(`old-session-${index}`, dreamedAt - DAY + index)),
        ...Array.from({ length: 5 }, (_, index) => conversation(`new-session-${index}`, after(index))),
        // Everything an automation opened (an `a-` mint or an origin), plus one abandoned before its first turn ran.
        ...Array.from({ length: 40 }, (_, index) => conversation(`a-front-desk-${index}`, after(index))),
        ...Array.from({ length: 40 }, (_, index) =>
            conversation(`visitor-${index}`, after(index), { origin: { automationId: "front-desk", provider: "webchat" } }),
        ),
        ...Array.from({ length: 40 }, (_, index) => conversation(`abandoned-${index}`, after(index), { turns: 0 })),
    ];
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), {}, [], registry);
    await services.automations.upsert(gatedNightly("dream"));
    await services.automations.upsert(gatedNightly("dream-2"));
    const prompts: string[] = [];

    await fireAutomation(services, (await services.automations.get("dream")) as AutomationRecord, fakeWake(prompts));
    expect((await services.automations.get("dream"))?.runs[0]).toMatchObject({ outcome: "skipped", detail: "5 of 30 sessions since the last wake" });

    // dream-2 measures from its own last wake, two days earlier, so both the old and new sessions count.
    await fireAutomation(services, (await services.automations.get("dream-2")) as AutomationRecord, fakeWake(prompts));
    expect((await services.automations.get("dream-2"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain(`45 sessions since ${new Date(dreamedAt - 2 * DAY).toISOString()}, the last time this automation woke an agent. Newest first:\nnew-session-4 · `);
});

test("a re-fire on the conversation a fire already minted is not measured against itself", async () => {
    // Simulates a re-fire on its own minted conversation, which must not measure zero sessions against itself.
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), {}, [], [conversation("a-dream-mabc", DAY)]);
    await services.automations.upsert(gatedNightly("dream"));
    const prompts: string[] = [];
    await fireAutomation(services, (await services.automations.get("dream")) as AutomationRecord, fakeWake(prompts), {
        conversationId: "a-dream-mabc",
        cleared: "approval",
        attempts: 1,
    });
    expect((await services.automations.get("dream"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts).toEqual(["wake:dream"]);
});

test("event automations never tick; fireAutomation hands the payload to the guard and the prompt", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("hook", { trigger: { kind: "event" }, guard: `test "$AUTOMATION_PAYLOAD" = "ping"` }));
    await services.automations.upsert(automationConfig("sched"));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("sched"))?.runs).toHaveLength(1), SETTLES);
    expect((await services.automations.get("hook"))?.runs).toEqual([]);
    expect(prompts).toEqual(["wake:sched"]);

    // Guard passes only because the payload reached it; the prompt carries it too.
    const hook = (await services.automations.get("hook")) as AutomationRecord;
    await fireAutomation(services, hook, fakeWake(prompts), { payload: "ping" });
    expect((await services.automations.get("hook"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts[1]).toBe("wake:hook\n\n--- Event payload ---\nping");

    await fireAutomation(services, hook, fakeWake(prompts), { payload: "pong" });
    expect((await services.automations.get("hook"))?.runs[0]?.outcome).toBe("skipped");
    expect(prompts).toHaveLength(2);
});

// The ladder's resolved rung (model, harness, effort, thinking) rides the wake whole, with no runRole behind it, since
// the automation's required ladder leaves nothing for a role to fill.
test("the automation's own ladder resolves onto the wake, tier and all, with no run role behind it", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(
        automationConfig("pinned", { models: [{ provider: "codex", model: "gpt-5-codex", harness: "claude-code", effort: "high", thinking: true }] }),
    );
    const inputs: AgentTurn[] = [];
    const capture: WakeFn = async function* (_services, input) {
        inputs.push(input);
        yield { kind: "done" };
    };
    await fireAutomation(services, (await services.automations.get("pinned")) as AutomationRecord, capture);
    expect(inputs[0]).toMatchObject({
        prompt: "wake:pinned",
        agent: "codex",
        model: "gpt-5-codex",
        harness: "claude-code",
        effort: "high",
        thinking: true,
    });
    expect(inputs[0]?.runRole).toBeUndefined();
    expect(inputs.every((turn) => turn.conversationId !== undefined)).toBe(true);
    expect(inputs.every((turn) => turn.unattended === true)).toBe(true);
});

test("outside and scheduled fires both open isolated conversations, and only provenance differs", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("support"));
    const inputs: AgentTurn[] = [];
    const capture: WakeFn = async function* (_services, input) {
        inputs.push(input);
        yield { kind: "done" };
    };
    const record = (await services.automations.get("support")) as AutomationRecord;
    const origin = { automationId: "support", provider: "discord", channelId: "c1", author: "ada" };
    await fireAutomation(services, record, capture, { payload: "hi", origin, title: "ada: hi" });
    // A schedule fire of the same automation carries no origin, but still runs in its own worktree.
    await fireAutomation(services, record, capture);

    const surfaced = inputs[0] as AgentTurn;
    expect(surfaced.origin).toEqual(origin);
    expect(surfaced.isolated).toBe(true);
    expect(surfaced.title).toBe("ada: hi");
    // Conversation id becomes a branch name and worktree dir, and names its automation.
    expect(surfaced.conversationId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    expect(surfaced.conversationId).toContain("support");
    const scheduled = inputs[1] as AgentTurn;
    expect(scheduled).toMatchObject({ prompt: "wake:support", conversationId: expect.any(String), isolated: true });
    expect(scheduled.origin).toBeUndefined();
    expect(scheduled.title).toBeUndefined();

    // One conversation per fire: a repeated message opens a new agent, never a resumed one.
    await fireAutomation(services, record, capture, { payload: "again", origin, title: "ada: again" });
    expect((inputs[2] as AgentTurn).conversationId).not.toBe(surfaced.conversationId);
});

test("a held external wake snapshots its provenance, so approving it opens the same conversation", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("gated-chat", { requireApproval: true }));
    const record = (await services.automations.get("gated-chat")) as AutomationRecord;
    const origin = { automationId: "gated-chat", provider: "webchat", channelId: "v-7", author: "visitor" };
    await fireAutomation(services, record, fakeWake([]), { payload: "help", origin, title: "visitor: help" });
    const held = (await services.heldWakes.list())[0];
    expect(held).toMatchObject({ payload: "help", origin, title: "visitor: help" });
});

test(`a requireApproval automation holds the wake instead of running it; cleared: "both" runs it`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("gated", { requireApproval: true }));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect(await services.heldWakes.list()).toHaveLength(1), SETTLES);
    expect(prompts).toEqual([]);
    expect((await services.automations.get("gated"))?.runs).toEqual([]);
    expect((await services.heldWakes.list())[0]?.automationId).toBe("gated");

    await automationIdle("gated");
    const record = (await services.automations.get("gated")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "both" });
    expect(prompts).toEqual(["wake:gated"]);
    expect((await services.automations.get("gated"))?.runs[0]?.outcome).toBe("completed");
});

test("a holdForSeconds fire is held with a deadline, and the tick releases it once the countdown passes on a quiet fleet", async () => {
    const live: string[] = ["turn-1"];
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), {}, live);
    await services.automations.upsert(automationConfig("fixer", { trigger: { kind: "event" }, holdForSeconds: 1 }));
    const prompts: string[] = [];
    const record = (await services.automations.get("fixer")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { payload: "checks broke" });
    const held = (await services.heldWakes.list())[0];
    expect(held?.automationId).toBe("fixer");
    expect(held?.payload).toBe("checks broke");
    expect(held?.autoRunAt).toBeGreaterThan(Date.now());
    expect(prompts).toEqual([]);

    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    // Before the deadline, the hold stays regardless of what the fleet is doing.
    await scheduler.tick(Date.now());
    expect(await services.heldWakes.list()).toHaveLength(1);
    // Past the deadline but the fleet is busy: the hold stays, since a countdown never starts work under someone.
    await scheduler.tick(Date.now() + 2_000);
    expect(await services.heldWakes.list()).toHaveLength(1);
    expect(prompts).toEqual([]);
    // Past the deadline and quiet: the wake runs once, with the held payload.
    live.length = 0;
    await scheduler.tick(Date.now() + 2_000);
    await vi.waitFor(async () => expect((await services.automations.get("fixer"))?.runs).toHaveLength(1), SETTLES);
    expect(await services.heldWakes.list()).toEqual([]);
    expect(prompts).toEqual(["wake:fixer\n\n--- Event payload ---\nchecks broke"]);
});

test("cancelling is just removing the hold, and disabling the automation mid-countdown counts as the cancel", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("fixer", { trigger: { kind: "event" }, holdForSeconds: 1 }));
    const prompts: string[] = [];
    const record = (await services.automations.get("fixer")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { payload: "checks broke" });
    await services.automations.upsert(automationConfig("fixer", { trigger: { kind: "event" }, holdForSeconds: 1, enabled: false }));
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(Date.now() + 2_000);
    await vi.waitFor(async () => expect(await services.heldWakes.list()).toEqual([]), SETTLES);
    expect(prompts).toEqual([]);
});

test(`requireApproval wins over holdForSeconds: "ask me" never becomes "unless I'm slow"`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("gated-fixer", { trigger: { kind: "event" }, requireApproval: true, holdForSeconds: 1 }));
    const prompts: string[] = [];
    const record = (await services.automations.get("gated-fixer")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts));
    expect((await services.heldWakes.list())[0]?.autoRunAt).toBeUndefined();
    // No deadline: the scan never touches it, only the owner's click can run it.
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(Date.now() + 60_000);
    expect(await services.heldWakes.list()).toHaveLength(1);
    expect(prompts).toEqual([]);
});

test("a streamed wake pipes text deltas to the sink, ends it, and tells the agent not to self-send", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("chat"));
    const prompts: string[] = [];
    const wake = fakeWake(prompts, [{ kind: "delta", text: "Hel" }, { kind: "delta", text: "lo" }, { kind: "done" }]);
    const chunks: string[] = [];
    const failures: string[] = [];
    let ended = false;
    const stream = {
        delta: (text: string) => chunks.push(text),
        failed: (reason: string) => failures.push(reason),
        end: () => {
            ended = true;
        },
    };
    const record = (await services.automations.get("chat")) as AutomationRecord;
    await fireAutomation(services, record, wake, { stream });
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(ended).toBe(true);
    // A turn that answered sends nothing on the failure frame.
    expect(failures).toEqual([]);
    // Note precedes the automation's own prompt.
    expect(prompts[0]).toContain("delivered to the user live");
    expect(prompts[0]).toContain("wake:chat");
});

test("a wake that dies tells the sink why before closing it: an empty close reads as nothing to say", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("dead-air"));
    const wake = fakeWake([], [{ kind: "error", message: "no credits" }, { kind: "done" }]);
    const frames: string[] = [];
    const record = (await services.automations.get("dead-air")) as AutomationRecord;
    await fireAutomation(services, record, wake, {
        stream: {
            delta: (text) => frames.push(`delta:${text}`),
            failed: (reason) => frames.push(`failed:${reason}`),
            end: () => frames.push("end"),
        },
    });
    expect(frames).toEqual(["failed:no credits", "end"]);
});

test("disabled automations and not-yet-due crons never fire; agent errors land as error runs", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("off", { enabled: false }));
    await services.automations.upsert(automationConfig("later", { trigger: { kind: "schedule", cron: "0 0 1 1 *" } }));
    await services.automations.upsert(automationConfig("broken"));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts, [{ kind: "error", message: "no credits" }, { kind: "done" }]));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("broken"))?.runs).toHaveLength(1), SETTLES);
    expect((await services.automations.get("broken"))?.runs[0]).toMatchObject({ outcome: "error", detail: "no credits" });
    expect((await services.automations.get("off"))?.runs).toEqual([]);
    expect((await services.automations.get("later"))?.runs).toEqual([]);
    expect(prompts).toEqual(["wake:broken"]);
});

test("a wake journals itself while in flight and clears the entry when it settles", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("nightly", { trigger: { kind: "event" } }));
    const record = (await services.automations.get("nightly")) as AutomationRecord;
    // Observed from inside the wake, since the entry exists only for the window where the daemon could die.
    let inFlightEntry: unknown;
    const peeking: WakeFn = async function* () {
        inFlightEntry = (await services.turnJournal.list())[0];
        yield { kind: "done" };
    };
    const origin = { automationId: "nightly", provider: "webhook" };
    await fireAutomation(services, record, peeking, { payload: "ping", origin, title: "Webhook: nightly" });

    // Journal holds the trigger inputs, not the resolved turn, since a re-fire re-reads the automation's prompt.
    expect(inFlightEntry).toEqual({
        kind: "automation",
        automationId: "nightly",
        conversationId: expect.any(String),
        payload: "ping",
        origin,
        title: "Webhook: nightly",
        startedAt: expect.any(Number),
        attempts: 0,
    });
    expect(await services.turnJournal.list()).toEqual([]);
});

test("a guard that skips never journals, and an error run still clears its entry", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("skipper", { guard: "exit 1" }));
    await services.automations.upsert(automationConfig("failer"));
    const journalled: number[] = [];
    const peeking: WakeFn = async function* () {
        journalled.push((await services.turnJournal.list()).length);
        yield { kind: "error", message: "no credits" };
        yield { kind: "done" };
    };
    await fireAutomation(services, (await services.automations.get("skipper")) as AutomationRecord, peeking);
    expect(journalled).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);

    await fireAutomation(services, (await services.automations.get("failer")) as AutomationRecord, peeking);
    expect(journalled).toEqual([1]);
    expect(await services.turnJournal.list()).toEqual([]);
    expect((await services.automations.get("failer"))?.runs[0]?.outcome).toBe("error");
});

test("the journal entry carries no stream note, so a re-fire sends its own reply", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("chat-note"));
    const record = (await services.automations.get("chat-note")) as AutomationRecord;
    let entryPayload: string | undefined = "unset";
    const peeking: WakeFn = async function* () {
        const entry = (await services.turnJournal.list())[0];
        entryPayload = entry?.kind === "automation" ? entry.payload : undefined;
        yield { kind: "done" };
    };
    await fireAutomation(services, record, peeking, { stream: { delta: () => {}, failed: () => {}, end: () => {} } });
    expect(entryPayload).toBeUndefined();
});

test(`cleared: "approval" skips the approval gate but still runs the guard: the answer a test-fire wants`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("gated-hand", { requireApproval: true }));
    const prompts: string[] = [];
    const record = (await services.automations.get("gated-hand")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "approval" });
    expect(prompts).toEqual(["wake:gated-hand"]);
    expect(await services.heldWakes.list()).toEqual([]);

    // The guard is NOT skipped: "skipped by guard" is the most useful thing a by-hand fire can report.
    await services.automations.upsert(automationConfig("gated-guard", { requireApproval: true, guard: "echo not today; exit 1" }));
    const guarded = (await services.automations.get("gated-guard")) as AutomationRecord;
    await fireAutomation(services, guarded, fakeWake(prompts), { cleared: "approval" });
    expect(prompts).toEqual(["wake:gated-hand"]);
    expect((await services.automations.get("gated-guard"))?.runs[0]).toMatchObject({ outcome: "skipped", detail: "not today" });
});

test("a run record carries the stable conversation even when the provider mints no runtime session", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("traced"));
    await services.automations.upsert(automationConfig("sessionless"));
    const withSession = fakeWake([], [{ kind: "session", sessionId: "sess-42" }, { kind: "done" }]);
    await fireAutomation(services, (await services.automations.get("traced")) as AutomationRecord, withSession);
    const traced = (await services.automations.get("traced"))?.runs[0];
    expect(traced).toMatchObject({ outcome: "completed", conversationId: expect.stringContaining("a-traced-") });
    expect(traced?.conversationId).not.toBe("sess-42");

    await fireAutomation(services, (await services.automations.get("sessionless")) as AutomationRecord, fakeWake([]));
    expect((await services.automations.get("sessionless"))?.runs[0]?.conversationId).toContain("a-sessionless-");
});

// Spin-loop guard: a job failing every time is disabled at the configured streak, rather than spending a turn every
// tick forever. Its run history, including what earned the quarantine, stays on the row.
const failing: WakeFn = async function* () {
    yield { kind: "error", message: "no credits" };
    yield { kind: "done" };
};

const fireUntil = async (services: Services, id: string, times: number): Promise<void> => {
    for (let i = 0; i < times; i += 1) {
        const record = await services.automations.get(id);
        if (record !== undefined) {
            await fireAutomation(services, record, failing);
        }
    }
};

test("an automation that keeps failing is disabled at the configured streak", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { automationFailureLimit: 2 });
    await services.automations.upsert(automationConfig("spinner"));
    await fireUntil(services, "spinner", 1);
    expect((await services.automations.get("spinner"))?.enabled).toBe(true);
    await fireUntil(services, "spinner", 1);
    const quarantined = await services.automations.get("spinner");
    expect(quarantined?.enabled).toBe(false);
    expect(quarantined?.runs.filter((run) => run.outcome === "error")).toHaveLength(2);
});

test("the guard is off by default: a job may fail forever until the owner asks for it", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("stubborn"));
    await fireUntil(services, "stubborn", 5);
    expect((await services.automations.get("stubborn"))?.enabled).toBe(true);
});

test("a successful run resets the streak", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { automationFailureLimit: 2 });
    await services.automations.upsert(automationConfig("flaky"));
    await fireUntil(services, "flaky", 1);
    await fireAutomation(services, (await services.automations.get("flaky")) as AutomationRecord, fakeWake([]));
    await fireUntil(services, "flaky", 1);
    expect((await services.automations.get("flaky"))?.enabled).toBe(true);
});

test("an admission-floor hold parks a wake whose automation asked for nothing, and it never auto-runs", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { admission: { schedule: "hold" } });
    await services.automations.upsert(automationConfig("plain"));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect(await services.heldWakes.list()).toHaveLength(1), SETTLES);
    expect((await services.heldWakes.list())[0]?.autoRunAt).toBeUndefined();
    expect(prompts).toEqual([]);

    await automationIdle("plain");
    const record = (await services.automations.get("plain")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "both" });
    expect(prompts).toEqual(["wake:plain"]);
});

test("an admission-floor deny refuses the wake and says so on the run record", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { admission: { schedule: "deny" } });
    await services.automations.upsert(automationConfig("refused"));
    const prompts: string[] = [];
    const record = (await services.automations.get("refused")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts));
    expect(prompts).toEqual([]);
    expect(await services.heldWakes.list()).toEqual([]);
    const run = (await services.automations.get("refused"))?.runs[0];
    expect(run?.outcome).toBe("skipped");
    expect(run?.detail).toContain("admission policy");
});

test("a deny refuses even an approved replay: approve-then-tighten does not execute", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { admission: { schedule: "deny" } });
    await services.automations.upsert(automationConfig("revoked"));
    const prompts: string[] = [];
    const record = (await services.automations.get("revoked")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "both" });
    expect(prompts).toEqual([]);
    expect((await services.automations.get("revoked"))?.runs[0]?.outcome).toBe("skipped");
});

test("the webchat floor keys off its own source: a listener rule does not reach the Front Desk, nor vice versa", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { admission: { listener: "hold" } });
    await services.automations.upsert(
        automationConfig("door", { trigger: { kind: "listener", provider: "webchat", allowedOrigins: ["https://a.example"] } }),
    );
    const prompts: string[] = [];
    const record = (await services.automations.get("door")) as AutomationRecord;
    // Visitor payload rides sealed in the outside-content envelope, same id on both ends.
    await fireAutomation(services, record, fakeWake(prompts), { payload: "hi" });
    expect(prompts[0]).toMatch(
        /^wake:door\n\n--- Event payload ---\n<untrusted-content source="webchat" id="([0-9a-f]{16})">\nhi\n<\/untrusted-content id="\1">$/,
    );

    const heldServices = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { admission: { webchat: "hold" } });
    await heldServices.automations.upsert(
        automationConfig("door", { trigger: { kind: "listener", provider: "webchat", allowedOrigins: ["https://a.example"] } }),
    );
    const heldPrompts: string[] = [];
    const heldRecord = (await heldServices.automations.get("door")) as AutomationRecord;
    await fireAutomation(heldServices, heldRecord, fakeWake(heldPrompts), { payload: "hi" });
    expect(heldPrompts).toEqual([]);
    expect((await heldServices.heldWakes.list())[0]?.automationId).toBe("door");
});

// Wake that blocks until released, so a second fire can arrive mid-run; `started` resolves once the wake is actually
// running, which a test must await before firing again.
const gatedWake = (prompts: string[]): { wake: WakeFn; started: Promise<void>; release: () => void } => {
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    return {
        started: started.promise,
        release: held.resolve,
        async *wake(_services, input) {
            prompts.push(input.prompt);
            started.resolve();
            await held.promise;
            yield { kind: "done" };
        },
    };
};

test("a fire meeting a running one is dropped by default, and the sink is told why rather than left silent", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("busy"));
    const prompts: string[] = [];
    const { wake, started, release } = gatedWake(prompts);
    const record = (await services.automations.get("busy")) as AutomationRecord;
    const first = fireAutomation(services, record, wake, { payload: "one" });
    await started;

    const failures: string[] = [];
    const ends: number[] = [];
    const stream = { delta: () => {}, failed: (reason: string) => void failures.push(reason), end: () => void ends.push(1) };
    expect(await fireAutomation(services, record, wake, { payload: "two", stream })).toEqual({});
    expect(failures).toEqual(["this automation is already running, so the message was not picked up"]);
    expect(ends).toHaveLength(1);
    release();
    await first;
    expect(prompts).toHaveLength(1);
});

test(`overlap: "queue" makes an inbound message wait its turn instead of being lost`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("busy"));
    const prompts: string[] = [];
    const { wake, started, release } = gatedWake(prompts);
    const record = (await services.automations.get("busy")) as AutomationRecord;
    const first = fireAutomation(services, record, wake, { payload: "one" });
    await started;

    const failures: string[] = [];
    const queued = fireAutomation(services, record, fakeWake(prompts), {
        payload: "two",
        overlap: "queue",
        stream: { delta: () => {}, failed: (reason: string) => void failures.push(reason), end: () => {} },
    });
    // Still only the first turn: the queued fire hasn't jumped ahead.
    expect(prompts).toHaveLength(1);
    release();
    await first;
    await queued;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("two");
    expect(failures).toEqual([]);
    // Both fires reached a turn, so both appear in the run history.
    expect((await services.automations.get("busy"))?.runs).toHaveLength(2);
});

test("the queue survives a run that fails: the next fire still gets its turn", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automationConfig("busy"));
    const prompts: string[] = [];
    const record = (await services.automations.get("busy")) as AutomationRecord;
    const started = Promise.withResolvers<void>();
    const held = Promise.withResolvers<void>();
    // oxlint-disable-next-line require-yield -- WakeFn is a generator contract; this fixture exists to throw before it ever yields.
    const throwingWake: WakeFn = async function* (_services, input) {
        prompts.push(input.prompt);
        started.resolve();
        await held.promise;
        throw new Error("wake exploded");
    };
    const first = fireAutomation(services, record, throwingWake, { payload: "one" });
    await started.promise;
    const queued = fireAutomation(services, record, fakeWake(prompts), { payload: "two", overlap: "queue" });
    held.resolve();
    await first;
    await queued;
    expect(prompts).toHaveLength(2);
});
