import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentEvent, AgentTurn, Automation } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { fileApprovalsStore } from "./approvals-store.js";
import { type AutomationRecord, fileAutomationsStore } from "./automations-store.js";
import { createAutomationsScheduler, fireAutomation, type WakeFn } from "./scheduler.js";

// The scheduler only touches automations/approvals/activity/workspace/logger; a cast keeps the fake that small.
const fakeServices = (root: string): Services =>
    ({
        automations: fileAutomationsStore(join(root, "automations.json")),
        approvals: fileApprovalsStore(join(root, "approvals")),
        activity: { append: async () => {}, list: async () => [] },
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
    await fireAutomation(services, hook, "ping", fakeWake(prompts));
    expect((await services.automations.get("hook"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts[1]).toBe("wake:hook\n\n--- Event payload ---\nping");

    // A payload the guard rejects skips the wake.
    await fireAutomation(services, hook, "pong", fakeWake(prompts));
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
    await fireAutomation(services, (await services.automations.get("pinned")) as AutomationRecord, undefined, capture);
    await fireAutomation(services, (await services.automations.get("plain")) as AutomationRecord, undefined, capture);
    expect(inputs[0]).toEqual({ prompt: "wake:pinned", agent: "codex", harness: "claude-code", model: "gpt-5-codex" });
    expect(inputs[1]).toEqual({ prompt: "wake:plain" });
});

test("a requireApproval automation holds the wake instead of running it; preApproved runs it", async () => {
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

    // Approving replays it with preApproved=true: the gate is bypassed, the agent wakes, a run is recorded.
    const record = (await services.automations.get("gated")) as AutomationRecord;
    await fireAutomation(services, record, undefined, fakeWake(prompts), true);
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
    await fireAutomation(services, record, undefined, wake, false, stream);
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
