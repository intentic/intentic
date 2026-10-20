import { join } from "node:path";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import { type RestartResume, restartResume } from "../../agent/run/turn/recovery/restart-resume-policy.js";
import { fileCapabilitiesStore } from "../../capabilities/capabilities-store.js";
import type { Services } from "../../composition.js";
import type { TurnStarter } from "../../seams/turn-starter.js";
import { drivenBy } from "../../seams/turn-starter.testing.js";
import { fileThreadSessionsStore } from "../../sessions/thread-sessions.js";
import { conversationsDbPath, openConversationsDb } from "../../store/conversations-db.js";
import { type JournalledFire, sqliteTurnJournal } from "../../store/journals/turn-journal.js";
import { fileWebchatOutbox, outboxStreamFor } from "../../webchat/webchat-outbox.js";
import { fileAutomationsStore } from "../automations-store.js";
import { automationInboxesInFlight, interruptedFiresInFlight, recoverCutFires } from "../fire-resume.js";
import { settingsResume } from "../../agent/run/turn/recovery/cut-turns.testing.js";
import { recoverKinds } from "../../seams/restart/in-flight.testing.js";
import { fileHeldWakesStore } from "../held-wakes-store.js";
import { fileScheduleCoverageStore } from "../schedule-coverage.js";
import { fileSendersStore } from "../senders-store.js";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { createDomainEvents } from "../../seams/domain-events.js";

// One daemon over a sandbox's state, for a restart test: every store opened fresh on `root`, so a second call over the
// same root is the daemon after a restart, with nothing of the first one's memory (durable/daemon-memory.ts keys
// what the dispatchers keep on the automations store made here). `crash()` stops the first one dead: from then on its
// manifest never answers, so whatever it still had in flight (a debounce timer, a queued fire) hangs, as it would in a
// process that is gone, and never writes over what the restarted one reads. `crashAt` does the same from inside a step.
export interface TestDaemon {
    readonly services: Services;
    readonly crash: () => void;
}

const never = new Promise<never>(() => undefined);

// Where a test kills the daemon mid-step: before or after a manifest write, answering true for the call to die at.
export type CrashPoint = (method: keyof Services["automations"], phase: "before" | "after") => boolean;

export const daemonOn = (root: string, wake: TurnStarter["stream"], crashAt: CrashPoint = () => false): TestDaemon => {
    let crashed = false;
    const store = fileAutomationsStore(join(root, "automations.json"), join(root, "automation-runs.json"));
    // Every method of the manifest hangs once crashed; built once, since the daemon's memory is keyed on this object.
    const alive = async <T>(method: keyof Services["automations"], call: () => Promise<T>): Promise<T> => {
        crashed ||= crashAt(method, "before");
        if (crashed) {
            return never;
        }
        const done = await call();
        crashed ||= crashAt(method, "after");
        return crashed ? never : done;
    };
    const automations: Services["automations"] = {
        list: () => alive("list", () => store.list()),
        get: (id) => alive("get", () => store.get(id)),
        upsert: (automation) => alive("upsert", () => store.upsert(automation)),
        setEnabled: (id, enabled) => alive("setEnabled", () => store.setEnabled(id, enabled)),
        remove: (id) => alive("remove", () => store.remove(id)),
        recordRun: (id, run) => alive("recordRun", () => store.recordRun(id, run)),
        recordWatch: (id, next) => alive("recordWatch", () => store.recordWatch(id, next)),
        onSaved: (listener) => store.onSaved(listener),
    };
    const webchatOutbox = fileWebchatOutbox(join(root, "history", "webchat-outbox.json"));
    const logger = unstubbed<Services["logger"]>("logger", { error: () => {}, warn: () => {}, info: () => {} });
    const services = unstubbed<Services>("services", {
        // Heard by nobody: what reacts to a wake's settled run is composition's to subscribe.
        events: createDomainEvents(() => {}),
        agents: unstubbed<Services["agents"]>("agents", { entry: () => undefined, ids: () => [] }),
        // Real actors under a wake's detached run (turn-runs.ts): the archived check, and the run it holds while live.
        conversations: unstubbed<Services["conversations"]>("conversations", { ...memoryFleet().conversations, liveSessionIds: () => [], sessionIdOf: () => undefined }),
        automations,
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => SandboxSettingsSchema.parse({ automationThreadsAtOnce: 4 }) }),
        capabilities: fileCapabilitiesStore(join(root, "capabilities.json")),
        threadSessions: fileThreadSessionsStore(join(root, "thread-sessions.json"), () => false),
        senders: fileSendersStore(join(root, "senders.json")),
        heldWakes: fileHeldWakesStore(join(root, "history")),
        config: unstubbed<Services["config"]>("config", { historyRoot: join(root, "history") }),
        scheduleCoverage: fileScheduleCoverageStore(join(root, "automation-schedule.json")),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        pushSender: unstubbed<Services["pushSender"]>("pushSender", { notifyIfAway: async () => ({ delivered: 0, failed: 0 }) }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger,
        // The real Visitor chat outbox and resolver: an answer a restart re-fire sends lands where the visitor's next
        // poll reads it, which is what the tests assert.
        webchatOutbox,
        outboxStreamFor: (origin) => outboxStreamFor({ webchatOutbox, logger }, origin),
    });
    const driven = drivenBy(services, wake);
    // A message steered into a running turn is refused, so it waits for a fire of its own like one the turn cannot take.
    const refusingSteers = unstubbed<Services>("services", { ...driven, turns: { ...driven.turns, steer: async () => false } });
    return {
        services: refusingSteers,
        crash: () => {
            crashed = true;
        },
    };
};

// The boot's recovery of the fires a restart cut (fire-resume.ts, interruptedFiresInFlight), over what the journal holds
// now, at a clock of the suite's own; with no answer given, the setting's alone decides.
export const resumeInterruptedFires = async (services: Services, now: number = Date.now(), policy?: RestartResume): Promise<void> => {
    const left = (await services.turnJournal.list()).filter((entry): entry is JournalledFire => entry.kind === "automation");
    await recoverCutFires(services, left, policy ?? (await settingsResume(services)), now);
};

// The boot's automation kinds, read and recovered in the order bootstrap/restart/in-flight-kinds.ts lists them, under a policy that
// resumes.
export const bootAutomations = async (services: Services): Promise<void> =>
    recoverKinds(services, [interruptedFiresInFlight, automationInboxesInFlight], restartResume({ ownerAsked: false, storm: false, autoResumeOnRestart: true }));

// A turn that starts and never ends: the daemon dies under it.
export const hangingWake =
    (turns: AgentTurn[]): TurnStarter["stream"] =>
    async function* (input) {
        turns.push(input);
        yield { kind: "session", sessionId: `sess-${turns.length}` };
        await never;
    };

// A turn that answers at once, its words naming the payload line it woke on, so a test can tell whose answer is whose.
export const answeringWake =
    (turns: AgentTurn[], answerOf: (prompt: string) => string): TurnStarter["stream"] =>
    async function* (input) {
        turns.push(input);
        const said: AgentEvent = { kind: "delta", text: answerOf(input.prompt) };
        yield said;
        yield { kind: "done" };
    };
