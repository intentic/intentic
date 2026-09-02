import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type AgentTurn, type Automation, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { WORKSPACE_ROOT_EXCLUDE_ENV } from "@intentic/sandbox-contract/chores";
import { unstubbed } from "@intentic/testing";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import type { z } from "zod";
import { fileTurnJournal } from "../agent/turn-journal.js";
import type { Services } from "../composition.js";
import { fileHeldWakesStore } from "./held-wakes-store.js";
import { type AutomationRecord, fileAutomationsStore } from "./automations-store.js";
import { automationIdle, createAutomationsScheduler, fireAutomation, type WakeFn } from "./scheduler.js";

// The scheduler only touches automations/heldWakes/activity/turnJournal/workspace/logger/sandboxSettings:
// plus, for the countdown scan, the registry's liveSessionIds (`live` mutates in place, as a test's fleet
// does); `unstubbed` keeps the fake that small. The journal is a real one on a temp dir: the in-flight entry
// is what several tests assert on.
const fakeServices = (root: string, settings: z.input<typeof SandboxSettingsSchema> = {}, live: string[] = []): Services =>
    unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", { liveSessionIds: () => live }),
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        // Read by the spin-loop guard after a failed run. Defaults parse from `{}`, so the guard is OFF unless a
        // test asks for it, which is also the production default.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", {
            get: async () => SandboxSettingsSchema.parse(settings),
        }),
        heldWakes: fileHeldWakesStore(join(root, "approvals")),
        turnJournal: fileTurnJournal(join(root, "turns")),
        activity: { append: async () => {}, list: async () => [] },
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], open: async () => {}, append: async () => {} }),
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
    await vi.waitFor(async () => expect((await services.automations.get("inbox"))?.runs).toHaveLength(1), SETTLES);
    expect(prompts).toEqual(["wake:inbox"]);
    expect((await services.automations.get("inbox"))?.runs[0]?.outcome).toBe("completed");
});

test("a failing guard skips the wake and records why; a passing guard wakes", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("guarded", { guard: "echo nothing new; exit 1" }));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("guarded"))?.runs).toHaveLength(1), SETTLES);
    const skipped = (await services.automations.get("guarded"))?.runs[0];
    expect(skipped?.outcome).toBe("skipped");
    expect(skipped?.detail).toBe("nothing new");
    expect(prompts).toEqual([]);

    // Editing the guard keeps the history; the next due tick now wakes and prepends a completed run.
    await automationIdle("guarded");
    await services.automations.upsert(automation("guarded", { guard: "true" }));
    await scheduler.tick(pastDue() + 61_000);
    await vi.waitFor(async () => expect((await services.automations.get("guarded"))?.runs).toHaveLength(2), SETTLES);
    expect((await services.automations.get("guarded"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts).toEqual(["wake:guarded"]);
});

test("guards receive the reserved workspace-root directory to prune", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("scoped", { guard: `test "$${WORKSPACE_ROOT_EXCLUDE_ENV}" = "refs"` }));
    const prompts: string[] = [];
    await fireAutomation(services, (await services.automations.get("scoped")) as AutomationRecord, fakeWake(prompts));
    expect((await services.automations.get("scoped"))?.runs[0]?.outcome).toBe("completed");
    expect(prompts).toEqual(["wake:scoped"]);
});

test("event automations never tick; fireAutomation hands the payload to the guard and the prompt", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("hook", { trigger: { kind: "event", token: "t" }, guard: `test "$AUTOMATION_PAYLOAD" = "ping"` }));
    await services.automations.upsert(automation("sched"));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect((await services.automations.get("sched"))?.runs).toHaveLength(1), SETTLES);
    // Only the schedule automation fired: events wait for their webhook.
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
    expect(inputs[0]).toMatchObject({ prompt: "wake:pinned", agent: "codex", harness: "claude-code", model: "gpt-5-codex" });
    expect(inputs[1]).toMatchObject({ prompt: "wake:plain" });
    expect(inputs.every((turn) => turn.conversationId !== undefined)).toBe(true);
    /* A WAKE IS UNATTENDED, whatever else rides it: nobody is at a composer for a schedule that fires at 3am.
     * The tool set, the guard's refusals, the model default and whether the turn is worth retrieving workspace
     * context for all key off this one flag, and the dispatchers used to leave it unsaid. */
    expect(inputs.every((turn) => turn.unattended === true)).toBe(true);
});

test("outside and scheduled fires both open surfaced conversations with placement kept separate", async () => {
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
    // A schedule fire of the SAME automation carries no origin, so it is a workspace conversation.
    await fireAutomation(services, record, capture);

    const surfaced = inputs[0] as AgentTurn;
    expect(surfaced.origin).toEqual(origin);
    expect(surfaced.isolated).toBe(true);
    expect(surfaced.title).toBe("ada: hi");
    // The id is a legal conversation id (it becomes a branch name and a worktree dir) and names its automation.
    expect(surfaced.conversationId).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/);
    expect(surfaced.conversationId).toContain("support");
    expect(inputs[1]).toMatchObject({ prompt: "wake:support", conversationId: expect.any(String) });
    expect(inputs[1]).not.toHaveProperty("isolated");

    // One conversation per FIRE: a second message is a second agent, never a resumed one.
    await fireAutomation(services, record, capture, { payload: "again", origin, title: "ada: again" });
    expect((inputs[2] as AgentTurn).conversationId).not.toBe(surfaced.conversationId);
});

test("a held external wake snapshots its provenance, so approving it opens the same conversation", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("gated-chat", { requireApproval: true }));
    const record = (await services.automations.get("gated-chat")) as AutomationRecord;
    const origin = { automationId: "gated-chat", provider: "webchat", channelId: "v-7", author: "visitor" };
    await fireAutomation(services, record, fakeWake([]), { payload: "help", origin, title: "visitor: help" });
    const held = (await services.heldWakes.list())[0];
    expect(held).toMatchObject({ payload: "help", origin, title: "visitor: help" });
});

test(`a requireApproval automation holds the wake instead of running it; cleared: "both" runs it`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("gated", { requireApproval: true }));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    // The due cron enqueued one held wake and never woke the agent nor recorded a run.
    await vi.waitFor(async () => expect(await services.heldWakes.list()).toHaveLength(1), SETTLES);
    expect(prompts).toEqual([]);
    expect((await services.automations.get("gated"))?.runs).toEqual([]);
    expect((await services.heldWakes.list())[0]?.automationId).toBe("gated");

    // Approving replays it with cleared: "both": both gates are bypassed, the agent wakes, a run is recorded.
    await automationIdle("gated");
    const record = (await services.automations.get("gated")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "both" });
    expect(prompts).toEqual(["wake:gated"]);
    expect((await services.automations.get("gated"))?.runs[0]?.outcome).toBe("completed");
});

test("a holdForSeconds fire is held with a deadline, and the tick releases it once the countdown passes on a quiet fleet", async () => {
    const live: string[] = ["turn-1"];
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), {}, live);
    await services.automations.upsert(automation("fixer", { trigger: { kind: "event", token: "t" }, holdForSeconds: 1 }));
    const prompts: string[] = [];
    const record = (await services.automations.get("fixer")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { payload: "checks broke" });
    // Held, visibly, with the deadline the row's countdown renders, and no wake yet.
    const held = (await services.heldWakes.list())[0];
    expect(held?.automationId).toBe("fixer");
    expect(held?.payload).toBe("checks broke");
    expect(held?.autoRunAt).toBeGreaterThan(Date.now());
    expect(prompts).toEqual([]);

    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    // Before the deadline: still the owner's window, whatever the fleet is doing.
    await scheduler.tick(Date.now());
    expect(await services.heldWakes.list()).toHaveLength(1);
    // Past the deadline but the fleet is busy: the hold stays, a countdown never starts work under someone.
    await scheduler.tick(Date.now() + 2_000);
    expect(await services.heldWakes.list()).toHaveLength(1);
    expect(prompts).toEqual([]);
    // Past the deadline and quiet: silence was consent, the wake runs with the held payload, once.
    live.length = 0;
    await scheduler.tick(Date.now() + 2_000);
    await vi.waitFor(async () => expect((await services.automations.get("fixer"))?.runs).toHaveLength(1), SETTLES);
    expect(await services.heldWakes.list()).toEqual([]);
    expect(prompts).toEqual(["wake:fixer\n\n--- Event payload ---\nchecks broke"]);
});

test("cancelling is just removing the hold, and disabling the automation mid-countdown counts as the cancel", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("fixer", { trigger: { kind: "event", token: "t" }, holdForSeconds: 1 }));
    const prompts: string[] = [];
    const record = (await services.automations.get("fixer")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { payload: "checks broke" });
    await services.automations.upsert({ ...automation("fixer", { trigger: { kind: "event", token: "t" }, holdForSeconds: 1 }), enabled: false });
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(Date.now() + 2_000);
    // The stale hold is dropped rather than left to fire the day the automation is re-enabled.
    await vi.waitFor(async () => expect(await services.heldWakes.list()).toEqual([]), SETTLES);
    expect(prompts).toEqual([]);
});

test(`requireApproval wins over holdForSeconds: "ask me" never becomes "unless I'm slow"`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(
        automation("gated-fixer", { trigger: { kind: "event", token: "t" }, requireApproval: true, holdForSeconds: 1 }),
    );
    const prompts: string[] = [];
    const record = (await services.automations.get("gated-fixer")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts));
    expect((await services.heldWakes.list())[0]?.autoRunAt).toBeUndefined();
    // No deadline, so the scan never touches it: only the owner's click can run it.
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(Date.now() + 60_000);
    expect(await services.heldWakes.list()).toHaveLength(1);
    expect(prompts).toEqual([]);
});

test("a streamed wake pipes text deltas to the sink, ends it, and tells the agent not to self-send", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("chat"));
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
    // A turn that answered says nothing on the failure frame: the sink's audience is told once, either way.
    expect(failures).toEqual([]);
    // The streamed prompt carries the "don't send it yourself" note ahead of the automation's own prompt.
    expect(prompts[0]).toContain("delivered to the user live");
    expect(prompts[0]).toContain("wake:chat");
});

test("a wake that dies tells the sink why before closing it: an empty close reads as nothing to say", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("dead-air"));
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
    // The RAW reason, and ahead of the close: each sink decides what its own audience is told, but a stream
    // that only ever said `end` left whoever was waiting with the agent's silence instead of its error.
    expect(frames).toEqual(["failed:no credits", "end"]);
});

test("disabled automations and not-yet-due crons never fire; agent errors land as error runs", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("off", { enabled: false }));
    await services.automations.upsert(automation("later", { trigger: { kind: "schedule", cron: "0 0 1 1 *" } }));
    await services.automations.upsert(automation("broken"));
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
    await services.automations.upsert(automation("nightly", { trigger: { kind: "event", token: "t" } }));
    const record = (await services.automations.get("nightly")) as AutomationRecord;
    // Observed from INSIDE the wake: the entry exists exactly for the window where the daemon could die.
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
    // An error is an outcome the row can show, so the entry goes: only a fire that reached NO outcome stays.
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
    await fireAutomation(services, record, peeking, { stream: { delta: () => {}, failed: () => {}, end: () => {} } });
    expect(entryPayload).toBeUndefined();
});

test(`cleared: "approval" skips the approval gate but still runs the guard: the answer a test-fire wants`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("gated-hand", { requireApproval: true }));
    const prompts: string[] = [];
    const record = (await services.automations.get("gated-hand")) as AutomationRecord;
    // Pressing the button IS the approval, so the wake runs instead of landing in the owner's own queue.
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "approval" });
    expect(prompts).toEqual(["wake:gated-hand"]);
    expect(await services.heldWakes.list()).toEqual([]);

    // The guard is NOT skipped: "skipped by guard" is the most useful thing a by-hand fire can report.
    await services.automations.upsert(automation("gated-guard", { requireApproval: true, guard: "echo not today; exit 1" }));
    const guarded = (await services.automations.get("gated-guard")) as AutomationRecord;
    await fireAutomation(services, guarded, fakeWake(prompts), { cleared: "approval" });
    expect(prompts).toEqual(["wake:gated-hand"]);
    expect((await services.automations.get("gated-guard"))?.runs[0]).toMatchObject({ outcome: "skipped", detail: "not today" });
});

test("a run record carries the stable conversation even when the provider mints no runtime session", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("traced"));
    await services.automations.upsert(automation("sessionless"));
    const withSession = fakeWake([], [{ kind: "session", sessionId: "sess-42" }, { kind: "done" }]);
    await fireAutomation(services, (await services.automations.get("traced")) as AutomationRecord, withSession);
    const traced = (await services.automations.get("traced"))?.runs[0];
    expect(traced).toMatchObject({ outcome: "completed", conversationId: expect.stringContaining("a-traced-") });
    expect(traced?.conversationId).not.toBe("sess-42");

    // A provider that minted none is still openable through the daemon's conversation transcript.
    await fireAutomation(services, (await services.automations.get("sessionless")) as AutomationRecord, fakeWake([]));
    expect((await services.automations.get("sessionless"))?.runs[0]?.conversationId).toContain("a-sessionless-");
});

/* THE SPIN-LOOP GUARD. A job that fails every time is misconfigured, and the scheduler would otherwise keep
 * spending a turn on it on every tick. At the configured streak it is disabled instead, and the run history
 * that earned the quarantine stays on the row, because that is what tells the reader why it stopped. */
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
    await services.automations.upsert(automation("spinner"));
    await fireUntil(services, "spinner", 1);
    // One failure is not a pattern: the job stays live.
    expect((await services.automations.get("spinner"))?.enabled).toBe(true);
    await fireUntil(services, "spinner", 1);
    const quarantined = await services.automations.get("spinner");
    expect(quarantined?.enabled).toBe(false);
    // The runs that earned it survive the disable, so the row can say why it stopped.
    expect(quarantined?.runs.filter((run) => run.outcome === "error")).toHaveLength(2);
});

test("the guard is off by default: a job may fail forever until the owner asks for it", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("stubborn"));
    await fireUntil(services, "stubborn", 5);
    expect((await services.automations.get("stubborn"))?.enabled).toBe(true);
});

// A run that succeeds breaks the streak, so an intermittent failure never accumulates into a quarantine.
test("a successful run resets the streak", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { automationFailureLimit: 2 });
    await services.automations.upsert(automation("flaky"));
    await fireUntil(services, "flaky", 1);
    await fireAutomation(services, (await services.automations.get("flaky")) as AutomationRecord, fakeWake([]));
    await fireUntil(services, "flaky", 1);
    expect((await services.automations.get("flaky"))?.enabled).toBe(true);
});

test("an admission-floor hold parks a wake whose automation asked for nothing, and it never auto-runs", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { admission: { schedule: "hold" } });
    await services.automations.upsert(automation("plain"));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(services, fakeWake(prompts));
    await scheduler.tick(pastDue());
    await vi.waitFor(async () => expect(await services.heldWakes.list()).toHaveLength(1), SETTLES);
    // "Ask me" from the floor is the same "ask me" as requireApproval: no deadline for the scan to release.
    expect((await services.heldWakes.list())[0]?.autoRunAt).toBeUndefined();
    expect(prompts).toEqual([]);

    // The owner's approval replays it: the grant satisfies the hold.
    await automationIdle("plain");
    const record = (await services.automations.get("plain")) as AutomationRecord;
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "both" });
    expect(prompts).toEqual(["wake:plain"]);
});

test("an admission-floor deny refuses the wake and says so on the run record", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { admission: { schedule: "deny" } });
    await services.automations.upsert(automation("refused"));
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
    await services.automations.upsert(automation("revoked"));
    const prompts: string[] = [];
    const record = (await services.automations.get("revoked")) as AutomationRecord;
    // The owner approved this wake before the policy tightened; the checks re-run live, so it still refuses.
    await fireAutomation(services, record, fakeWake(prompts), { cleared: "both" });
    expect(prompts).toEqual([]);
    expect((await services.automations.get("revoked"))?.runs[0]?.outcome).toBe("skipped");
});

test("the webchat floor keys off its own source: a listener rule does not reach the Front Desk, nor vice versa", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { admission: { listener: "hold" } });
    await services.automations.upsert(
        automation("door", { trigger: { kind: "listener", provider: "webchat", allowedOrigins: ["https://a.example"] } }),
    );
    const prompts: string[] = [];
    const record = (await services.automations.get("door")) as AutomationRecord;
    // listener:hold does not hold a webchat wake: the Front Desk has its own admission key. The visitor's
    // payload rides sealed in the outside-content envelope, same id on both ends.
    await fireAutomation(services, record, fakeWake(prompts), { payload: "hi" });
    expect(prompts[0]).toMatch(
        /^wake:door\n\n--- Event payload ---\n<untrusted-content source="webchat" id="([0-9a-f]{16})">\nhi\n<\/untrusted-content id="\1">$/,
    );

    const heldServices = fakeServices(mkdtempSync(join(tmpdir(), "sched-")), { admission: { webchat: "hold" } });
    await heldServices.automations.upsert(
        automation("door", { trigger: { kind: "listener", provider: "webchat", allowedOrigins: ["https://a.example"] } }),
    );
    const heldPrompts: string[] = [];
    const heldRecord = (await heldServices.automations.get("door")) as AutomationRecord;
    await fireAutomation(heldServices, heldRecord, fakeWake(heldPrompts), { payload: "hi" });
    expect(heldPrompts).toEqual([]);
    expect((await heldServices.heldWakes.list())[0]?.automationId).toBe("door");
});

/* A wake that blocks until the test lets it go, so a second fire can be made to arrive mid-run. The gate
 * resolves when the wake has actually started, which is what a test must wait for before firing again: the
 * fire is only "in flight" once the turn is running. */
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
    await services.automations.upsert(automation("busy"));
    const prompts: string[] = [];
    const { wake, started, release } = gatedWake(prompts);
    const record = (await services.automations.get("busy")) as AutomationRecord;
    const first = fireAutomation(services, record, wake, { payload: "one" });
    await started;

    const failures: string[] = [];
    const ends: number[] = [];
    const stream = { delta: () => {}, failed: (reason: string) => void failures.push(reason), end: () => void ends.push(1) };
    expect(await fireAutomation(services, record, wake, { payload: "two", stream })).toEqual({});
    // Refused, and SAID so: a dropped fire that closed its sink in silence read as the agent having nothing
    // to say, which is the opposite of what happened.
    expect(failures).toEqual(["this automation is already running, so the message was not picked up"]);
    expect(ends).toHaveLength(1);
    release();
    await first;
    expect(prompts).toHaveLength(1);
});

test(`overlap: "queue" makes an inbound message wait its turn instead of being lost`, async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("busy"));
    const prompts: string[] = [];
    const { wake, started, release } = gatedWake(prompts);
    const record = (await services.automations.get("busy")) as AutomationRecord;
    const first = fireAutomation(services, record, wake, { payload: "one" });
    await started;

    const failures: string[] = [];
    // The second fire is a message somebody is waiting on: it queues, so its sink stays open and unfailed.
    const queued = fireAutomation(services, record, fakeWake(prompts), {
        payload: "two",
        overlap: "queue",
        stream: { delta: () => {}, failed: (reason: string) => void failures.push(reason), end: () => {} },
    });
    // Still only the first turn: the queued one has not jumped the running one.
    expect(prompts).toHaveLength(1);
    release();
    await first;
    await queued;
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("two");
    expect(failures).toEqual([]);
    // Both fires reached a turn, so both are on the row's history.
    expect((await services.automations.get("busy"))?.runs).toHaveLength(2);
});

test("the queue survives a run that fails: the next fire still gets its turn", async () => {
    const services = fakeServices(mkdtempSync(join(tmpdir(), "sched-")));
    await services.automations.upsert(automation("busy"));
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
