import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import type { PersistedAgent } from "../../conversations/registry/agents-store.js";
import { automationConfig } from "../../harness/route-stores.testing.js";
import { sqliteTurnJournal } from "../../agent/run/turn/turn-journal.js";
import { conversationsDbPath, openConversationsDb } from "../../store/conversations-db.js";
import type { TurnStarter } from "../../seams/turn-starter.js";
import { conversationEntry, drivenBy, fakeTurns } from "../../testing.js";
import { fileHeldWakesStore } from "../held-wakes-store.js";
import { fileScheduleCoverageStore } from "../schedule-coverage.js";
import { type AutomationRecord, fileAutomationsStore, WATCH_VALUE_MAX } from "../automations-store.js";
import { automationIdle, fireAutomation, runHeldWake } from "../scheduler.js";

// A watch's fires end to end, through the real store, shell and held-wakes queue: what it compares, when it starts over,
// how two approved holds are told apart, and that an end date is said once.

const fakeServices = (root: string, registry: readonly PersistedAgent[] = []): Services =>
    unstubbed<Services>("services", {
        agents: unstubbed<Services["agents"]>("agents", {
            ids: () => registry.map((entry) => entry.id),
            entry: (id) => registry.find((entry) => entry.id === id),
        }),
        conversations: unstubbed<Services["conversations"]>("conversations", { liveSessionIds: () => [], sessionIdOf: () => undefined }),
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json")),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({}) }),
        heldWakes: fileHeldWakesStore(join(root, "approvals")),
        scheduleCoverage: fileScheduleCoverageStore(join(root, "automation-schedule.json")),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        activity: { append: async () => {}, list: async () => [] },
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        pushSender: unstubbed<Services["pushSender"]>("pushSender", {
            notify: async () => ({ delivered: 1, failed: 0 }),
            notifyIfAway: async () => ({ delivered: 1, failed: 0 }),
        }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {}, info: () => {} }),
        outboxStreamFor: () => undefined,
        threadSessions: unstubbed<Services["threadSessions"]>("threadSessions", { settle: async () => {} }),
    });

const recordingWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): TurnStarter["stream"] =>
    async function* (input) {
        prompts.push(input.prompt);
        yield* events;
    };

const tmp = (): string => mkdtempSync(join(tmpdir(), "watch-fires-"));

const fire = async (services: Services, id: string): Promise<AutomationRecord> => {
    await fireAutomation(services, (await services.automations.get(id)) as AutomationRecord, {});
    await automationIdle(id);
    return (await services.automations.get(id)) as AutomationRecord;
};

test("a change watch whose check prints more than WATCH_VALUE_MAX stays quiet while nothing changes, and still fires on a change", async () => {
    const root = tmp();
    const services = fakeServices(root);
    const page = join(root, "page.txt");
    // One long, unchanging page: a status page or changelog easily passes 16k characters of text.
    await Bun.write(page, "x".repeat(WATCH_VALUE_MAX + 4_000));
    await services.automations.upsert(automationConfig("page-watch", { guard: `cat ${page}`, fireOn: "change" }));
    const prompts: string[] = [];
    const driven = drivenBy(services, recordingWake(prompts));

    const baseline = await fire(driven, "page-watch");
    expect(baseline.runs[0]?.detail).toContain("First check");

    // Nothing moved: this check must be quiet and wake nobody.
    await fire(driven, "page-watch");
    await fire(driven, "page-watch");
    expect(prompts).toHaveLength(0);

    // A change past the part of the value that is kept still counts, and is said as lying past it.
    await Bun.write(page, `${"x".repeat(WATCH_VALUE_MAX + 4_000)}y`);
    await fire(driven, "page-watch");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain("the change lies past the first");
});

test("editing a change watch to look at something else starts it over with a baseline, rather than comparing against the old check", async () => {
    const services = fakeServices(tmp());
    await services.automations.upsert(
        automationConfig("releases", { guard: "echo 'bun-v1.4.3'", fireOn: "change", note: "releases of oven-sh/bun" }),
    );
    const prompts: string[] = [];
    const driven = drivenBy(services, recordingWake(prompts));
    await fire(driven, "releases");
    expect((await services.automations.get("releases"))?.watch?.value).toBe("bun-v1.4.3");

    // The owner edits it under the same id to watch a different repository.
    await services.automations.upsert(automationConfig("releases", { guard: "echo 'v25.0.0'", fireOn: "change", note: "releases of nodejs/node" }));
    const afterEdit = await fire(driven, "releases");

    // The first check of the new condition is a baseline ("First check: noted ..."), no wake.
    expect(prompts).toEqual([]);
    expect(afterEdit.runs[0]?.detail).toContain("First check");
});

test("two held wakes of a conversation-target watch, approved together, are delivered under their own message ids", async () => {
    const root = tmp();
    const registry = [conversationEntry({ id: "rapid-ridge" })];
    const services = fakeServices(root, registry);
    const flag = join(root, "flag");
    const automation = automationConfig("held-resume", {
        guard: `cat ${flag}`,
        requireApproval: true,
        target: { kind: "conversation", conversationId: "rapid-ridge" },
        prompt: "Pick the plan back up.",
    });
    const { models: _models, ...noModels } = automation;
    await services.automations.upsert(noModels);

    // Two checks pass while nobody is there, each held for approval with what it saw.
    await Bun.write(flag, "first");
    await fire(services, "held-resume");
    await Bun.sleep(5);
    await Bun.write(flag, "second");
    await fire(services, "held-resume");
    const held = (await services.heldWakes.list()).toSorted((a, b) => a.createdAt - b.createdAt);
    expect(held.map((entry) => entry.observed)).toEqual(["first", "second"]);

    // The owner approves both, as the approve route does: a fresh record, then runHeldWake.
    const turns = fakeTurns();
    const driven = unstubbed<Services>("services", { ...services, turns: turns.turns as Services["turns"] });
    for (const entry of held) {
        await runHeldWake(driven, (await services.automations.get("held-resume")) as AutomationRecord, entry);
        await automationIdle("held-resume");
    }
    expect(turns.started).toHaveLength(2);
    const ids = turns.started.map((turn) => turn.messageId);
    // One id per fire. The real admission (turn-admission.ts `duplicate`) answers a repeated id with the first
    // delivery's receipt and delivers nothing, while the run is still recorded "completed".
    expect(new Set(ids).size).toBe(2);
});

test("an automation past its end date says so once: a later Run now is answered in its history without telling anyone again", async () => {
    const pushes: string[] = [];
    const base = fakeServices(tmp());
    const services = unstubbed<Services>("services", {
        ...base,
        pushSender: unstubbed<Services["pushSender"]>("pushSender", {
            notify: async (notification) => {
                pushes.push(notification.title);
                return { delivered: 1, failed: 0 };
            },
            notifyIfAway: async (notification) => {
                pushes.push(notification.title);
                return { delivered: 1, failed: 0 };
            },
        }),
    });
    await services.automations.upsert(automationConfig("ended", { guard: "exit 1", expiresAt: Date.now() + 20, note: "Bun 1.4.3" }));
    await Bun.sleep(30);
    // The tick's own expiry, as the scheduler pass does it.
    const { createAutomationsScheduler } = await import("../scheduler.js");
    await createAutomationsScheduler(services).tick(Date.now());
    expect((await services.automations.get("ended"))?.enabled).toBe(false);
    expect(pushes).toEqual(["Watch gave up"]);

    // The owner presses "Run now" (automations.routes.ts `run`: cleared "approval", works when switched off), twice.
    for (let press = 0; press < 2; press++) {
        await fireAutomation(services, (await services.automations.get("ended")) as AutomationRecord, { cleared: "approval" });
        await automationIdle("ended");
    }
    const after = (await services.automations.get("ended")) as AutomationRecord;
    // It already ended once; the owner is not told again, and the history does not grow a fresh "end" per press.
    expect(pushes).toEqual(["Watch gave up"]);
    expect(after.runs.filter((run) => run.detail?.includes("Reached its end date"))).toHaveLength(1);
    // Each press is answered, though: what happened to it, and what would make it run.
    expect(after.runs.filter((run) => run.detail?.includes("move the end date to run it again"))).toHaveLength(2);
});
