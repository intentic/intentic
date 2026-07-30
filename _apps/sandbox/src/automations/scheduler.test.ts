import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTurn, Automation } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { fileTurnJournal } from "../agent/turn-journal.js";
import type { Services } from "../composition.js";
import { fileApprovalsStore } from "./approvals-store.js";
import { type AutomationRecord, fileAutomationsStore } from "./automations-store.js";
import { createAutomationsScheduler, fireAutomation, type WakeFn } from "./scheduler.js";

// The scheduler only touches automations/approvals/activity/turnJournal/workspace/logger; a cast keeps the fake
// that small. The journal is a real one on a temp dir — the in-flight entry is the thing several tests assert on.
const fakeServices = (root: string): Services =>
    ({
        automations: fileAutomationsStore(join(root, "automations.json")),
        approvals: fileApprovalsStore(join(root, "approvals")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        activity: { append: async () => {}, list: async () => [] },
        pushSender: { notifyIfAway: async () => {} },
        workspace: { root },
        logger: { error: () => {}, warn: () => {} },
    }) as unknown as Services;

// A fake wake that records the prompts it was called with; `events` lets a test surface an agent error.
const fakeWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): WakeFn =>
    async function* (_services, input) {
        prompts.push(input.prompt);
        yield* events;
    };

const automation = (id: string, extra: Partial<Automation> = {}): Automation => ({
    id,
    trigger: { kind: "schedule", cron: "* * * * *" },
    prompt: `wake:${id}`,
    enabled: true,
    ...extra,
});

// Ticking 61s past construction guarantees an every-minute cron has exactly one occurrence in the window.
const pastDue = (): number => Date.now() + 61_000;

test("a due cron wakes the agent once and records a completed run", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("inbox"));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("inbox"))?.runs).toHaveLength(1));
    expect(prompts).toEqual(["wake:inbox"]);
    expect((await services.automations.get("inbox"))?.runs[0]?.outcome).toBe("completed");
});

test("a failing guard skips the wake and records why; a passing guard wakes", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("guarded", { guard: "echo nothing new; exit 1" }));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("guarded"))?.runs).toHaveLength(1));
    const skipped = (await services.automations.get("guarded"))?.runs[0];
    expect(skipped?.outcome).toBe("skipped");
    expect(skipped?.detail).toBe("nothing new");
    expect(prompts).toEqual([]);

    // Editing the guard keeps the history; the next due tick now wakes and prepends a completed run.
    await services.automations.upsert(automation("guarded", { guard: "true" }));
    await scheduler.tick(pastDue() + 61_000);
    await vi.waitFor(async () => expect((await services.automations.get("guarded"))?.runs).toHaveLength(2));
    expect((await services.automations.get("guarded"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts).toEqual(["wake:guarded"]);
});

test("event automations never tick; fireAutomation hands the payload to the guard and the prompt", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("hook", { trigger: { kind: "event", token: "t" }, guard: `test "$AUTOMATION_PAYLOAD" = "ping"` }));
    await services.automations.upsert(automation("sched"));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("sched"))?.runs).toHaveLength(1));
    // Only the schedule automation fired — events wait for their webhook.
    expect((await services.automations.get("hook"))?.runs).toEqual([]);
    expect(prompts).toEqual(["wake:sched"]);

    // A webhook fire: the guard passes only because the payload reached it, and the prompt carries it too.
    const hook = (await services.automations.get("hook")) as AutomationRecord;
    await fireAutomation(services, hook, fakeWake(prompts), { payload: "ping" });
    expect((await services.automations.get("hook"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts[1]).toBe("wake:hook\n\n--- Event payload ---\nping");

    // A payload the guard rejects skips the wake.
    await fireAutomation(services, hook, fakeWake(prompts), { payload: "pong" });
    expect((await services.automations.get("hook"))?.runs[0]?.outcome).toBe("skipped");
    expect(prompts).toHaveLength(2);
});

test("an automation's agent/harness/model ride the wake; unset fields leave the turn bare", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("pinned", { agent: "codex", harness: "claude-code", model: "gpt-5-codex" }));
    await services.automations.upsert(automation("plain"));
    const inputs: AgentTurn[] = [];
    const capture: WakeFn = async function* (_services, input) {
        inputs.push(input);
        yield { kind: "done" };
    };
    await fireAutomation(services, (await services.automations.get("pinned")) as AutomationRecord, capture);
    await fireAutomation(services, (await services.automations.get("plain")) as AutomationRecord, capture);
    expect(inputs[0]).toEqual({ prompt: "wake:pinned", agent: "codex", harness: "claude-code", model: "gpt-5-codex" });
    expect(inputs[1]).toEqual({ prompt: "wake:plain" });
});

test("an outside message opens a surfaced conversation; a schedule wake stays headless", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("support"));
    const inputs: AgentTurn[] = [];
    const capture: WakeFn = async function* (_services, input) {
        inputs.push(input);
        yield { kind: "done" };
    };
    const record = (await services.automations.get("support")) as AutomationRecord;
    const origin = { automationId: "support", provider: "discord", channelId: "c1", author: "ada" };
    await fireAutomation(services, record, capture, { payload: "hi", origin, title: "ada: hi" });
    // A schedule fire of the SAME automation carries no origin, so it stays an anonymous main-tree turn.
    await fireAutomation(services, record, capture);

    const surfaced = inputs[0] as AgentTurn;
    expect(surfaced.origin).toEqual(origin);
    expect(surfaced.isolated).toBe(true);
    expect(surfaced.title).toBe("ada: hi");
    // The id is a legal conversation id (it becomes a branch name and a worktree dir) and names its automation.
    expect(surfaced.conversationId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    expect(surfaced.conversationId).toContain("support");
    expect(inputs[1]).toEqual({ prompt: "wake:support" });

    // One conversation per FIRE — a second message is a second agent, never a resumed one.
    await fireAutomation(services, record, capture, { payload: "again", origin, title: "ada: again" });
    expect((inputs[2] as AgentTurn).conversationId).not.toBe(surfaced.conversationId);
});

test("a held external wake snapshots its provenance, so approving it opens the same conversation", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("gated-chat", { requireApproval: true }));
    const record = (await services.automations.get("gated-chat")) as AutomationRecord;
    const origin = { automationId: "gated-chat", provider: "webchat", channelId: "v-7", author: "visitor" };
    await fireAutomation(services, record, fakeWake([]), { payload: "help", origin, title: "visitor: help" });
    const held = (await services.approvals.list())[0];
    expect(held).toMatchObject({ payload: "help", origin, title: "visitor: help" });
});

test(`a requireApproval automation holds the wake instead of running it; cleared: "both" runs it`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("gated", { requireApproval: true }));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    // The due cron enqueued one held wake and never woke the agent nor recorded a run.
    await vi.waitFor(async () => expect(await services.approvals.list()).toHaveLength(1));
    expect(prompts).toEqual([]);
    expect((await services.automations.get("gated"))?.runs).toEqual([]);
    expect((await services.approvals.list())[0]?.automationId).toBe("gated");

    // Approving replays it with cleared: "both": both gates are bypassed, the agent wakes, a run is recorded.
    const record = (await services.automations.get("gated")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "both" });
    expect(prompts).toEqual(["wake:gated"]);
    expect((await services.automations.get("gated"))?.runs[0]?.outcome).toBe("completed");
});

test("a streamed wake pipes text deltas to the sink, ends it, and tells the agent not to self-send", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("chat"));
    const prompts: string[] = [];
    const wake = fakeWake(prompts, [{ kind: "delta", text: "Hel" }, { kind: "delta", text: "lo" }, { kind: "done" }]);
    const chunks: string[] = [];
    let ended = false;
    const stream = {
        delta: (text: string) => chunks.push(text),
        end: () => {
            ended = true;
        },
    };
    const record = (await services.automations.get("chat")) as AutomationRecord;
    await fireAutomation(services, record, wake, { stream });
    expect(chunks).toEqual(["Hel", "lo"]);
    expect(ended).toBe(true);
    // The streamed prompt carries the "don't send it yourself" note ahead of the automation's own prompt.
    expect(prompts[0]).toContain("delivered to the user live");
    expect(prompts[0]).toContain("wake:chat");
});

test("disabled automations and not-yet-due crons never fire; agent errors land as error runs", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("off", { enabled: false }));
    await services.automations.upsert(automation("later", { trigger: { kind: "schedule", cron: "0 0 1 1 *" } }));
    await services.automations.upsert(automation("broken"));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts, [{ kind: "error", message: "no credits" }, { kind: "done" }]));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("broken"))?.runs).toHaveLength(1));
    expect((await services.automations.get("broken"))?.runs[0]).toMatchObject({ outcome: "error", detail: "no credits" });
    expect((await services.automations.get("off"))?.runs).toEqual([]);
    expect((await services.automations.get("later"))?.runs).toEqual([]);
    expect(prompts).toEqual(["wake:broken"]);
});

test("a wake journals itself while in flight and clears the entry when it settles", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("nightly", { trigger: { kind: "event", token: "t" } }));
    const record = (await services.automations.get("nightly")) as AutomationRecord;
    // Observed from INSIDE the wake — the entry exists exactly for the window where the daemon could die.
    let inFlightEntry: unknown;
    const peeking: WakeFn = async function* () {
        inFlightEntry = (await services.turnJournal.list())[0];
        yield { kind: "done" };
    };
    const origin = { automationId: "nightly", provider: "webhook" };
    await fireAutomation(services, record, peeking, { payload: "ping", origin, title: "Webhook: nightly" });

    // The TRIGGER inputs, not the resolved turn: a re-fire goes back through fireAutomation, which re-reads the
    // automation's own (possibly since-fixed) prompt.
    expect(inFlightEntry).toEqual({
        kind: "automation",
        automationId: "nightly",
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
    await services.automations.upsert(automation("skipper", { guard: "exit 1" }));
    await services.automations.upsert(automation("failer"));
    const journalled: number[] = [];
    const peeking: WakeFn = async function* () {
        journalled.push((await services.turnJournal.list()).length);
        yield { kind: "error", message: "no credits" };
        yield { kind: "done" };
    };
    await fireAutomation(services, (await services.automations.get("skipper")) as AutomationRecord, peeking);
    // The wake never ran, so nothing was ever in flight to write down.
    expect(journalled).toEqual([]);
    expect(await services.turnJournal.list()).toEqual([]);

    await fireAutomation(services, (await services.automations.get("failer")) as AutomationRecord, peeking);
    expect(journalled).toEqual([1]);
    // An error is an outcome the row can show, so the entry goes — only a fire that reached NO outcome stays.
    expect(await services.turnJournal.list()).toEqual([]);
    expect((await services.automations.get("failer"))?.runs[0]?.outcome).toBe("error");
});

test("the journal entry carries no stream note, so a re-fire sends its own reply", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("chat-note"));
    const record = (await services.automations.get("chat-note")) as AutomationRecord;
    // The live sink dies with the daemon, so a wake still told "your reply is delivered live" would answer into
    // nothing. The note belongs to THIS fire; the journal keeps only the trigger inputs.
    let entryPayload: string | undefined = "unset";
    const peeking: WakeFn = async function* () {
        const entry = (await services.turnJournal.list())[0];
        entryPayload = entry?.kind === "automation" ? entry.payload : undefined;
        yield { kind: "done" };
    };
    await fireAutomation(services, record, peeking, { stream: { delta: () => {}, end: () => {} } });
    expect(entryPayload).toBeUndefined();
});

test(`cleared: "approval" skips the approval gate but still runs the guard — the answer a test-fire wants`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("gated-hand", { requireApproval: true }));
    const prompts: string[] = [];
    const record = (await services.automations.get("gated-hand")) as AutomationRecord;
    // Pressing the button IS the approval, so the wake runs instead of landing in the owner's own queue.
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "approval" });
    expect(prompts).toEqual(["wake:gated-hand"]);
    expect(await services.approvals.list()).toEqual([]);

    // The guard is NOT skipped: "skipped by guard" is the most useful thing a by-hand fire can report.
    await services.automations.upsert(automation("gated-guard", { requireApproval: true, guard: "echo not today; exit 1" }));
    const guarded = (await services.automations.get("gated-guard")) as AutomationRecord;
    await fireAutomation(services, guarded, fakeWake(prompts), { cleared: "approval" });
    expect(prompts).toEqual(["wake:gated-hand"]);
    expect((await services.automations.get("gated-guard"))?.runs[0]).toMatchObject({ outcome: "skipped", detail: "not today" });
});

test("a run record carries the session its wake ran in, so the row can open the transcript", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("traced"));
    await services.automations.upsert(automation("sessionless"));
    const withSession = fakeWake([], [{ kind: "session", sessionId: "sess-42" }, { kind: "done" }]);
    await fireAutomation(services, (await services.automations.get("traced")) as AutomationRecord, withSession);
    expect((await services.automations.get("traced"))?.runs[0]).toMatchObject({ outcome: "completed", sessionId: "sess-42" });

    // A provider that minted none leaves the field off rather than recording an unopenable id.
    await fireAutomation(services, (await services.automations.get("sessionless")) as AutomationRecord, fakeWake([]));
    expect((await services.automations.get("sessionless"))?.runs[0]?.sessionId).toBeUndefined();
});
