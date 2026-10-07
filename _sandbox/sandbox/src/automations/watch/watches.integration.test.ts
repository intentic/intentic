import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AgentEvent, type Automation, type PushNotification, SandboxSettingsSchema } from "@intentic/sandbox-contract";
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
import { type AutomationRecord, fileAutomationsStore } from "../automations-store.js";
import { automationIdle, createAutomationsScheduler, fireAutomation } from "../scheduler.js";
import { guardStateFile } from "./watch-condition.js";

// Watches: an automation whose check decides, with no model, whether anything happened, remembers what it saw, retires
// when it has done its job, and goes where it was pointed. Every check here is a guard command, so nothing reaches the
// network; the ready-made sources are covered on their own (watch-sources.test.ts).

interface Pushed {
    readonly always: PushNotification[];
    readonly ifAway: PushNotification[];
}

const fakeServices = (root: string, registry: readonly PersistedAgent[] = [], pushed: Pushed = { always: [], ifAway: [] }): Services =>
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
            notify: async (notification) => {
                pushed.always.push(notification);
                return { delivered: 1, failed: 0 };
            },
            notifyIfAway: async (notification) => {
                pushed.ifAway.push(notification);
                return { delivered: 1, failed: 0 };
            },
        }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger: unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {}, info: () => {} }),
        outboxStreamFor: () => undefined,
    });

const recordingWake = (prompts: string[], events: AgentEvent[] = [{ kind: "done" }]): TurnStarter["stream"] =>
    async function* (input) {
        prompts.push(input.prompt);
        yield* events;
    };

const tmp = (): string => mkdtempSync(join(tmpdir(), "watch-"));

const fire = async (services: Services, id: string, options: Parameters<typeof fireAutomation>[2] = {}): Promise<AutomationRecord> => {
    await fireAutomation(services, (await services.automations.get(id)) as AutomationRecord, options);
    await automationIdle(id);
    return (await services.automations.get(id)) as AutomationRecord;
};

test("what a passing guard prints goes with the wake, under its own heading", async () => {
    const services = fakeServices(tmp());
    await services.automations.upsert(automationConfig("release", { guard: "echo bun@1.4.3" }));
    const prompts: string[] = [];
    const after = await fire(drivenBy(services, recordingWake(prompts)), "release");
    expect(prompts).toEqual(["wake:release\n\n--- What the check saw ---\nbun@1.4.3"]);
    expect(after.runs[0]?.outcome).toBe("completed");
    expect(after.watch?.value).toBe("bun@1.4.3");
});

test("a guard keeps a file of its own between runs, and reads what it printed last time", async () => {
    const root = tmp();
    const services = fakeServices(root);
    // Counts its own runs in $AUTOMATION_STATE and prints what $AUTOMATION_LAST held.
    const guard = `n=$(cat "$AUTOMATION_STATE" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "$AUTOMATION_STATE"; echo "run $n after [\${AUTOMATION_LAST:-none}]"`;
    await services.automations.upsert(automationConfig("counter", { guard }));
    const prompts: string[] = [];
    const driven = drivenBy(services, recordingWake(prompts));
    await fire(driven, "counter");
    await fire(driven, "counter");
    expect(prompts.map((prompt) => prompt.split("\n").at(-1))).toEqual(["run 1 after [none]", "run 2 after [run 1 after [none]]"]);
    expect(readFileSync(guardStateFile(root, "counter"), "utf8").trim()).toBe("2");
});

test("firing on a change notes the first value, stays quiet while it holds, and fires with what moved", async () => {
    const root = tmp();
    const services = fakeServices(root);
    const versionFile = join(root, "version");
    await Bun.write(versionFile, "1.4.2\n");
    await services.automations.upsert(automationConfig("bun-release", { guard: `cat ${versionFile}`, fireOn: "change" }));
    const prompts: string[] = [];
    const driven = drivenBy(services, recordingWake(prompts));

    const first = await fire(driven, "bun-release");
    expect(first.runs[0]?.outcome).toBe("skipped");
    expect(first.runs[0]?.detail).toContain('noted "1.4.2"');
    expect(first.watch?.value).toBe("1.4.2");

    // Unchanged: no wake, and nothing written into the history.
    const second = await fire(driven, "bun-release");
    expect(second.runs).toHaveLength(1);
    expect(second.watch?.checkedAt).toBeGreaterThanOrEqual(first.watch?.checkedAt ?? 0);

    // Pressed by hand, the same quiet check is said, since that is the answer the button asked for.
    const byHand = await fire(driven, "bun-release", { cleared: "approval" });
    expect(byHand.runs[0]?.detail).toBe('Unchanged: still "1.4.2".');

    await Bun.write(versionFile, "1.4.3\n");
    const moved = await fire(driven, "bun-release");
    expect(moved.runs[0]?.outcome).toBe("completed");
    expect(prompts).toEqual(["wake:bun-release\n\n--- What the check saw ---\nIt was: 1.4.2\nIt is now: 1.4.3"]);
    expect(moved.watch?.value).toBe("1.4.3");
    expect(moved.watch?.firedAt).toEqual(expect.any(Number));
});

test("a check that does not pass says what it is waiting for, on the run and on the watch", async () => {
    const services = fakeServices(tmp());
    await services.automations.upsert(automationConfig("waiting", { guard: "echo 'no 1.4.3 yet (latest is 1.4.2)'; exit 1" }));
    const after = await fire(drivenBy(services, recordingWake([])), "waiting");
    expect(after.runs[0]).toMatchObject({ outcome: "skipped", detail: "no 1.4.3 yet (latest is 1.4.2)" });
    expect(after.watch?.waiting).toBe("no 1.4.3 yet (latest is 1.4.2)");
});

test("waiting for one thing retires as it fires, so the next due tick does nothing, and the owner hears it", async () => {
    const pushed: Pushed = { always: [], ifAway: [] };
    const services = fakeServices(tmp(), [], pushed);
    await services.automations.upsert(
        automationConfig("once-shipped", { guard: "echo shipped", until: "first-fire", note: "Bun 1.4.3 is published" }),
    );
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(drivenBy(services, recordingWake(prompts)));
    await scheduler.tick(Date.now() + 61_000);
    await automationIdle("once-shipped");
    await scheduler.tick(Date.now() + 122_000);
    await automationIdle("once-shipped");
    const after = (await services.automations.get("once-shipped")) as AutomationRecord;
    expect(prompts).toHaveLength(1);
    expect(after.enabled).toBe(false);
    expect(after.runs).toHaveLength(1);
    expect(pushed.ifAway.map((notification) => notification.body)).toEqual(["Bun 1.4.3 is published"]);
});

test("past its end date a watch switches off, records why, and tells the owner it never fired", async () => {
    const pushed: Pushed = { always: [], ifAway: [] };
    const services = fakeServices(tmp(), [], pushed);
    await services.automations.upsert(automationConfig("too-late", { guard: "exit 1", expiresAt: Date.now() + 30_000, note: "Bun 1.4.3" }));
    const prompts: string[] = [];
    const scheduler = createAutomationsScheduler(drivenBy(services, recordingWake(prompts)));
    await scheduler.tick(Date.now() + 61_000);
    const after = (await services.automations.get("too-late")) as AutomationRecord;
    expect(after.enabled).toBe(false);
    expect(after.runs[0]?.detail).toContain("without firing");
    expect(prompts).toEqual([]);
    expect(pushed.ifAway.map((notification) => notification.title)).toEqual(["Watch gave up"]);
});

test("a notify target runs no model: the owner's phone hears what the check saw", async () => {
    const pushed: Pushed = { always: [], ifAway: [] };
    const services = fakeServices(tmp(), [], pushed);
    const notifying: Automation = { ...automationConfig("tell-me", { guard: "echo bun@1.4.3", target: { kind: "notify" }, note: "Bun 1.4.3" }) };
    const { models: _models, ...noModels } = notifying;
    await services.automations.upsert(noModels);
    const prompts: string[] = [];
    const after = await fire(drivenBy(services, recordingWake(prompts)), "tell-me");
    expect(prompts).toEqual([]);
    expect(pushed.always).toEqual([{ title: "Bun 1.4.3", body: "bun@1.4.3", url: "/automations", tag: "automation-tell-me" }]);
    expect(after.runs[0]).toMatchObject({ outcome: "completed" });
    expect(after.runs[0]?.detail).toContain("Saw: bun@1.4.3");
});

test("a conversation target continues that conversation with the watch's notice and the automation's words", async () => {
    const registry = [conversationEntry({ id: "rapid-ridge" })];
    const services = fakeServices(tmp(), registry);
    const turns = fakeTurns();
    const automation = automationConfig("resume-plan", {
        guard: "echo bun@1.4.3",
        target: { kind: "conversation", conversationId: "rapid-ridge" },
        until: "first-fire",
        note: "Bun 1.4.3 is published",
        prompt: "Carry out the bun check migration plan.",
    });
    const { models: _models, ...noModels } = automation;
    await services.automations.upsert(noModels);
    const driven = unstubbed<Services>("services", { ...services, turns: turns.turns as Services["turns"] });
    const after = await fire(driven, "resume-plan");
    expect(turns.started).toHaveLength(1);
    const said = turns.started[0];
    expect(said?.conversationId).toBe("rapid-ridge");
    expect(said?.prompt.startsWith("Watch fired: the condition you were watching is now met.")).toBe(true);
    expect(said?.prompt).toContain("Watching: Bun 1.4.3 is published");
    expect(said?.prompt).toContain("bun@1.4.3");
    expect(said?.prompt).toContain("which has now switched itself off");
    expect(said?.prompt.endsWith("Carry out the bun check migration plan.")).toBe(true);
    expect(after.runs[0]).toMatchObject({ outcome: "completed", conversationId: "rapid-ridge" });
    expect(after.enabled).toBe(false);
});

test("a conversation target whose conversation is gone records an error rather than starting something else", async () => {
    const services = fakeServices(tmp());
    const { models: _models, ...automation } = automationConfig("orphan", { target: { kind: "conversation", conversationId: "gone" } });
    await services.automations.upsert(automation);
    const after = await fire(drivenBy(services, recordingWake([])), "orphan");
    expect(after.runs[0]?.outcome).toBe("error");
    expect(after.runs[0]?.detail).toContain("no longer exists");
});

test("a new agent with no model to run on is an error run, never a guess", async () => {
    const services = fakeServices(tmp());
    const { models: _models, ...automation } = automationConfig("modelless");
    await services.automations.upsert(automation);
    const prompts: string[] = [];
    const after = await fire(drivenBy(services, recordingWake(prompts)), "modelless");
    expect(prompts).toEqual([]);
    expect(after.runs[0]?.outcome).toBe("error");
});

test("a held watch keeps what its check saw, and the approved wake is told the same thing without checking again", async () => {
    const root = tmp();
    const services = fakeServices(root);
    const flag = join(root, "flag");
    await Bun.write(flag, "first");
    await services.automations.upsert(automationConfig("held", { guard: `cat ${flag}`, requireApproval: true }));
    const prompts: string[] = [];
    const driven = drivenBy(services, recordingWake(prompts));
    await fire(driven, "held");
    const [held] = await services.heldWakes.list();
    expect(held?.observed).toBe("first");
    // The world moved on; the approved wake still carries what was seen when it was held.
    await Bun.write(flag, "second");
    await fireAutomation(driven, (await services.automations.get("held")) as AutomationRecord, {
        cleared: "both",
        observed: held?.observed as string,
    });
    await automationIdle("held");
    expect(prompts).toEqual(["wake:held\n\n--- What the check saw ---\nfirst"]);
});
