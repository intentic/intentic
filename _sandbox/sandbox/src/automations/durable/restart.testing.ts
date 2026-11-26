import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { ListenerDeliverSchema } from "@intentic/sandbox-contract/protocol/doors/listener-protocol";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentTurn } from "@intentic/sandbox-contract/schemas/agent";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract/schemas/settings";
import { readWorkspaceFile } from "../../workspace/files/workspace-files.js";
import { unstubbed } from "@intentic/testing";
import { type RestartResume, restartResume } from "../../agent/run/turn/recovery/restart-resume-policy.js";
import { fileCapabilitiesStore } from "../../capabilities/capabilities-store.js";
import type { Services } from "../../composition.js";
import type { TurnStarter } from "../../seams/turn-starter.js";
import { drivenBy } from "../../seams/turn-starter.testing.js";
import { fileThreadSessionsStore } from "../../sessions/thread-sessions.js";
import { conversationsDbPath, openConversationsDb } from "../../store/conversations-db.js";
import { type JournalledFire, sqliteTurnJournal } from "../../store/journals/turn-journal.js";
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
    // What reached the `webchat` channel's gateway (`/deliver`): an answer no live stream carried, as the visitor gets it.
    readonly delivered: () => readonly { readonly channelId: string; readonly text: string }[];
}

// The chat channel's gateway, as the extension that owns a listener runs one: a manifest baked where the inventory reads
// it, and a loopback /deliver that keeps what it was sent. Unref'd, so a suite that ends leaves nothing running.
interface ChatGateway {
    readonly extensionsDir: string;
    readonly port: () => number | undefined;
    readonly delivered: () => { channelId: string; text: string }[];
}

const chatGateway = (root: string): ChatGateway => {
    const extensionsDir = join(root, "baked");
    mkdirSync(join(extensionsDir, "chat"), { recursive: true });
    writeFileSync(
        join(extensionsDir, "chat", "intentic-extension.json"),
        JSON.stringify({
            publisher: "test",
            name: "chat",
            version: "1.0.0",
            engines: { intentic: "^2.0.0" },
            contributes: {
                listener: {
                    provider: "webchat",
                    events: [{ type: "message", label: "Messages" }],
                    automation: { label: "Chat", channel: { label: "Thread", placeholder: "every thread" }, starterPrompt: "A message arrived." },
                },
                processes: [{ name: "gateway", command: "true" }],
            },
        }),
    );
    const delivered: { channelId: string; text: string }[] = [];
    const server = createServer((request, response) => {
        let body = "";
        request.on("data", (chunk: Buffer) => {
            body += chunk.toString("utf8");
        });
        request.on("end", () => {
            const deliver = ListenerDeliverSchema.parse(JSON.parse(body));
            delivered.push({ channelId: deliver.channelId, text: deliver.text });
            response.writeHead(200, { "content-type": "application/json" });
            response.end("{}");
        });
    });
    server.listen(0, "127.0.0.1");
    server.unref();
    // SAFETY: a server listening on a TCP port answers its address as an AddressInfo.
    return { extensionsDir, port: () => (server.address() as AddressInfo | null)?.port, delivered: () => [...delivered] };
};

const never = new Promise<never>(() => undefined);

// Where a test kills the daemon mid-step: before or after a manifest write, answering true for the call to die at.
export type CrashPoint = (method: keyof Services["automations"], phase: "before" | "after") => boolean;

export const daemonOn = (root: string, wake: TurnStarter["stream"], crashAt: CrashPoint = () => false): TestDaemon => {
    let crashed = false;
    const gateway = chatGateway(root);
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
        // The one extension installed is the chat's, whose gateway takes the answers no live stream carried.
        config: unstubbed<Services["config"]>("config", { historyRoot: join(root, "history"), extensionsDir: gateway.extensionsDir }),
        files: unstubbed<Services["files"]>("files", { read: readWorkspaceFile }),
        serviceProcesses: unstubbed<Services["serviceProcesses"]>("serviceProcesses", { portOf: () => gateway.port() }),
        scheduleCoverage: fileScheduleCoverageStore(join(root, "automation-schedule.json")),
        turnJournal: sqliteTurnJournal(openConversationsDb(conversationsDbPath(root))),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { read: async () => [], append: async () => {} }),
        activity: { append: async () => {}, list: async () => [] },
        pushSender: unstubbed<Services["pushSender"]>("pushSender", { notifyIfAway: async () => ({ delivered: 0, failed: 0 }) }),
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        logger,
    });
    const driven = drivenBy(services, wake);
    // A message steered into a running turn is refused, so it waits for a fire of its own like one the turn cannot take.
    const refusingSteers = unstubbed<Services>("services", { ...driven, turns: { ...driven.turns, steer: async () => false } });
    return {
        services: refusingSteers,
        crash: () => {
            crashed = true;
        },
        delivered: gateway.delivered,
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
