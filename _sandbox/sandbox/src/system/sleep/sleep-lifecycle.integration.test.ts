import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { beginTurn } from "../../conversations/actor/conversation-actors.testing.js";
import { fleetStoreOver, memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { conversationsDbPath, openConversationsDb } from "../../store/conversations-db.js";
import { sqliteTurnJournal } from "../../store/journals/turn-journal.js";
import { services as routeServices } from "../../harness/route-services.testing.js";
import { automationConfig } from "../../harness/route-stores.testing.js";
import { fileAutomationsStore } from "../../automations/automations-store.js";
import { fileScheduleCoverageStore } from "../../automations/schedule-coverage.js";
import { fileApprovalsStore } from "../../approvals/approvals-store.js";
import { automationIdle, createAutomationsScheduler } from "../../automations/scheduler.js";
import { createTurnResumeScheduler } from "../../agent/run/turn/turn-resume.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { drivenBy } from "../../seams/turn-starter.testing.js";
import { testConfig } from "../../env.config.testing.js";
import { createHostedSleep } from "./hosted-sleep.js";
import { startQuietWatch } from "../quiet-watch.js";
import { quietProbesOf } from "../quiet-watch.testing.js";
import { residentWorkspaceTree, startWorkspaceWatch } from "../../workspace/watch/workspace-watch.js";
import { subscribeSleepChanges } from "../../bootstrap/platform-presence.js";
import { nextPromisedWake } from "../../bootstrap/promised-wakes.js";

const logger = pino({ level: "silent" });

// The real files and conversation database survive; the model is the route harness's turn stream. Each boot makes new
// actors and new schedulers, so an in-memory timer or a cached entry from before sleep cannot deliver the booking.
const boot = async (root: string, heard: string[]) => {
    const db = openConversationsDb(conversationsDbPath(root));
    const fleet = memoryFleet(fleetStoreOver(db));
    await fleet.agents.init();
    const services = drivenBy(routeServices({
        ...fleet,
        logger,
        config: { ...testConfig, historyRoot: root },
        turnJournal: sqliteTurnJournal(db),
        automations: fileAutomationsStore(join(root, "automations.json"), join(root, "runs.json")),
        approvals: fileApprovalsStore(join(root, "approvals")),
        scheduleCoverage: fileScheduleCoverageStore(join(root, "coverage.json")),
    }), async function* (turn) {
        heard.push(turn.prompt);
        yield { kind: "done" };
    });
    const automations = createAutomationsScheduler(services);
    const messages = createTurnResumeScheduler(services);
    return {
        services, automations, messages,
        tick: async (at: number) => { await automations.tick(at); await messages.tick(at); },
        close: () => { automations.stop(); messages.stop(); db.db.close(); },
    };
};

test("automation file saves refresh the wake signal on create, retime and disable without a minute poll", async () => {
    const root = await mkdtemp(join(tmpdir(), "sleep-signal-"));
    const sandbox = await boot(root, []);
    const stopWorkspace = startWorkspaceWatch(root, logger);
    const watch = startQuietWatch(quietProbesOf({
        nextWakeAt: async () => (await nextPromisedWake(sandbox.services, "sleep")) ?? 0,
    }), { logger, checkMs: 1e9 });
    const unsubscribe = subscribeSleepChanges(sandbox.services, watch.invalidate);
    const at = Date.now() + 3_600_000;
    try {
        await residentWorkspaceTree(root)!;
        await watch.check();
        expect(watch.read().nextWakeAt).toBeUndefined();
        await sandbox.services.automations.upsert(automationConfig("reminder", { trigger: { kind: "once", at } }));
        await waitFor(() => expect(watch.read().nextWakeAt).toBe(at), SETTLES);
        await sandbox.services.automations.upsert(automationConfig("reminder", { trigger: { kind: "once", at: at + 3_600_000 } }));
        await waitFor(() => expect(watch.read().nextWakeAt).toBe(at + 3_600_000), SETTLES);
        await sandbox.services.automations.setEnabled("reminder", false);
        await waitFor(() => expect(watch.read().nextWakeAt).toBeUndefined(), SETTLES);
    } finally {
        unsubscribe();
        watch.stop();
        stopWorkspace();
        sandbox.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("sleep and two wakes deliver the earliest booked message and then the remaining automation exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "sleep-lifecycle-"));
    const heard: string[] = [];
    const saved: (number | null)[] = [];
    const at = Date.now() + 3_600_000;
    let sandbox: Awaited<ReturnType<typeof boot>> | undefined;
    const sleep = () => createHostedSleep(testConfig, logger, async (deadline) => { saved.push(deadline); return true; });
    try {
        sandbox = await boot(root, heard);
        await beginTurn(sandbox.services.conversations, { conversationId: "booked", isolated: true, prompt: "opened", profile: { agent: "grok", harness: "native" } }, Date.now());
        await sandbox.services.conversations.send("booked", { kind: "settle" }).settled;
        await sandbox.services.conversations.send("booked", { kind: "queue-scheduled", booking: { until: at }, item: {
            id: "send-1", voice: "person", queuedAt: Date.now(), turn: { conversationId: "booked", prompt: "scheduled message", agent: "grok" },
        } }).settled;
        await sandbox.services.automations.upsert(automationConfig("later", { trigger: { kind: "once", at: at + 3_600_000 } }));
        const firstAlarm = await nextPromisedWake(sandbox.services, "sleep");
        expect(firstAlarm).toBe(at);
        expect(await sleep().prepare(firstAlarm ?? 0)).toBe(true);
        sandbox.close();
        sandbox = undefined;
        expect(saved).toEqual([null, at]);

        // The platform wakes ahead of its saved deadline. New services read what the prior process left on disk.
        sandbox = await boot(root, heard);
        const secondSleep = sleep();
        expect(await nextPromisedWake(sandbox.services, "sleep")).toBe(at);
        await sandbox.tick(at - 1);
        expect(heard).toEqual([]);
        await sandbox.tick(at);
        await waitFor(() => expect(heard).toEqual(["scheduled message"]), SETTLES);
        await turnRunOf(sandbox.services.conversations, "booked")?.waitUntilFinished();
        expect(await nextPromisedWake(sandbox.services, "sleep")).toBe(at + 3_600_000);
        expect(await secondSleep.prepare(at + 3_600_000)).toBe(true);
        sandbox.close();
        sandbox = undefined;
        expect(saved).toEqual([null, at, null, at + 3_600_000]);

        sandbox = await boot(root, heard);
        const lastSleep = sleep();
        await sandbox.tick(at + 3_600_000 - 1);
        expect(heard).toEqual(["scheduled message"]);
        await sandbox.tick(at + 3_600_000);
        await automationIdle("later");
        await waitFor(() => expect(heard).toEqual(["scheduled message", "wake:later"]), SETTLES);
        await sandbox.tick(at + 3_600_000 + 60_000);
        expect(heard).toEqual(["scheduled message", "wake:later"]);
        expect((await sandbox.services.automations.get("later"))?.runs.map((run) => run.outcome)).toEqual(["completed"]);
        expect(await nextPromisedWake(sandbox.services, "sleep")).toBeUndefined();
        expect(await lastSleep.prepare(0)).toBe(true);
        expect(saved).toEqual([null, at, null, at + 3_600_000, null, null]);
    } finally {
        sandbox?.close();
        await rm(root, { recursive: true, force: true });
    }
});

test("a cron's alarm survives sleep and new schedulers deliver its occurrence once", async () => {
    const root = await mkdtemp(join(tmpdir(), "cron-sleep-"));
    const heard: string[] = [];
    const saved: (number | null)[] = [];
    let sandbox: Awaited<ReturnType<typeof boot>> | undefined;
    try {
        sandbox = await boot(root, heard);
        await sandbox.services.automations.upsert(automationConfig("recurring", { trigger: { kind: "schedule", cron: "0 0 1 1 *" } }));
        const at = await nextPromisedWake(sandbox.services, "sleep");
        if (at === undefined) { throw new Error("a cron must promise its next occurrence"); }
        const sleep = createHostedSleep(testConfig, logger, async (deadline) => { saved.push(deadline); return true; });
        expect(await sleep.prepare(at)).toBe(true);
        expect(saved).toEqual([null, at]);
        sandbox.close();
        sandbox = undefined;

        sandbox = await boot(root, heard);
        expect(await nextPromisedWake(sandbox.services, "idle-stop")).toBe(at);
        await sandbox.tick(at - 1);
        expect(heard).toEqual([]);
        await sandbox.tick(at);
        await automationIdle("recurring");
        await waitFor(() => expect(heard).toEqual(["wake:recurring"]), SETTLES);
        await sandbox.tick(at + 60_000);
        expect(heard).toEqual(["wake:recurring"]);
        expect((await sandbox.services.automations.get("recurring"))?.runs.map((run) => run.outcome)).toEqual(["completed"]);
    } finally {
        sandbox?.close();
        await rm(root, { recursive: true, force: true });
    }
});
