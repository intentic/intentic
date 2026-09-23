import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { HookJSONOutput, SyncHookJSONOutput } from "@anthropic-ai/claude-agent-sdk";
import { repoRoot } from "@intentic/constants/node";
import type { ListenerContribution } from "@intentic/extension-manifest";
import { unstubbed } from "@intentic/testing";
import { turnDoors } from "./agent/run/turn/turn-doors.js";
import type { ConversationActors } from "./agents/actor/conversation-actors.js";
import { turnJournalRows } from "./agent/run/turn/turn-journal.js";
import { createFleet, type Fleet, type FleetStore } from "./agents/registry/agents-registry.js";
import type { BeginTurn, ConversationEvent } from "./agents/actor/conversation-decide.js";
import { type IsolatedAgent, type PersistedAgent, type RepoRecord, sqliteAgentsStore } from "./agents/registry/agents-store.js";
import { type ConversationsDb, openConversationsDb } from "./store/conversations-db.js";
import type { ConversationUnits } from "./store/conversation-units.js";
import { IN_MEMORY } from "./store/sqlite.js";
import type { IsolationPlan, TurnIsolation } from "./agents/worktrees/isolation.js";
import { overlaysDir } from "./agents/worktrees/isolation.js";
import { sessionsDir } from "./sessions/session-store.js";
import type { CodexEvent, CodexRunner, CodexTurn } from "./runtimes/codex/codex-app-server.js";
import type { Config } from "./env.config.js";
import type { Services } from "./composition.js";
import type { Said, Steer, TurnInput, TurnStarter } from "./seams/turn-starter.js";
import { opt } from "./opt.js";

// Test-support seams specific to this daemon; the generic stand-in for a wide interface is `unstubbed` in
// @intentic/testing. Excluded from the build but type-checked via tsconfig.test.json, alongside every *.test.ts.

// Real first-party _extensions tree, so a capability fixture resolves against what the daemon ships.
const EXTENSIONS_DIR = join(repoRoot(import.meta.url), "_extensions");

// Manifest listener contribution kept plain: tests care about the provider/event vocabulary, not the automation
// metadata, which just keeps the fixture on the public shape.
export const listenerContribution = (provider: string, eventTypes: readonly string[]): ListenerContribution => ({
    provider,
    events: eventTypes.map((type) => ({ type, label: type })),
    automation: {
        label: provider,
        channel: { label: "Channel", placeholder: "all channels" },
        starterPrompt: `Handle ${provider} events.`,
    },
});

// historyRoot alone is diverted from its default, to a temp dir, so writes stay off the real workspace.
export const testConfig: Config = {
    workspaceRoot: WORKSPACE_ROOT,
    historyRoot: join(tmpdir(), "intentic-test-history"),
    extensionsDir: EXTENSIONS_DIR,
    agentAuthDir: "",
    logLevel: "silent",
    logPretty: false,
    idleStopMinutes: 0,
    zone: "",
    connectToken: "",
    owner: { email: "" },
    syncPairToken: "",
    hostPairToken: "",
    hostPlatform: "",
    hostLabel: "",
    webOrigin: "",
    platform: { url: "", publicKey: "" },
    intenticAgentTools: "",
    claudeCodeOauthToken: "",
    anthropicApiKey: "",
    openaiApiKey: "",
    cloudflareApiToken: "",
    translator: { url: "", token: "" },
    sandbox: {
        profile: "container",
        port: 8787,
        host: "0.0.0.0",
        publicUrl: "",
        vm: false,
        grant: "",
        allowUnauthenticated: false,
        name: "",
        image: "",
        baseImage: "",
        environmentHash: "",
        channel: "",
        previousImage: "",
        definitionSeed: "",
        devRoot: undefined,
        prewarm: false,
    },
    // No edge to dial; loopback-only is a supported posture here, not a gap.
    ingress: { url: "" },
    preview: { port: 5173 },
    google: { clientId: "" },
    acmeDirectoryUrl: "",
    intenticAgentModel: "",
    iqModelDir: "",
    iqRgPath: "",
    iqPluginDir: "",
    // Off, which is the shipped default: a plan test must not pay a pre-turn lookup it never asked for.
    iqTurnContext: false,
    webqPluginDir: "",
    local: { port: 8788 },
};

// HookJSONOutput is a union; only its synchronous half carries hookSpecificOutput, the field every hook suite asserts
// on. Throws if a hook answers in the async form instead.
export const syncHookOutput = (output: HookJSONOutput): SyncHookJSONOutput => {
    if ("async" in output) {
        throw new Error("the hook answered in its async form, which carries no hookSpecificOutput");
    }
    return output;
};

// Container without CAP_SYS_ADMIN, what the worktree suites use for the symlink-mirroring fallback; planFor still
// answers WHERE the worktree sits since that is a layout fact, not a kernel one.
export const noIsolation = (root: string, historyRoot: string = HISTORY_ROOT): TurnIsolation => ({
    available: async () => false,
    planFor: async (worktree: string, fenced: boolean): Promise<IsolationPlan> => ({
        worktree,
        root,
        mirrors: [],
        overlays: overlaysDir(historyRoot, basename(worktree)),
        fence: fenced ? { sessions: sessionsDir(historyRoot, basename(worktree)), hidden: [] } : undefined,
    }),
});

// One event list per resumed turn; the last repeats if asked again. `steered[n]` is what turn n's steering channel
// delivered, drained before the turn's first yielded event so nothing races an assertion.
export const fakeCodexRunner = (...turns: readonly (readonly CodexEvent[])[]): { runner: CodexRunner; calls: CodexTurn[]; steered: string[][] } => {
    const calls: CodexTurn[] = [];
    const steered: string[][] = [];
    const runner: CodexRunner = async function* (turn) {
        calls.push(turn);
        const delivered: string[] = [];
        steered.push(delivered);
        const steering = turn.steering;
        if (steering !== undefined) {
            void (async () => {
                for await (const text of steering) {
                    delivered.push(text);
                }
            })();
        }
        yield* turns[Math.min(calls.length - 1, turns.length - 1)] ?? [];
    };
    return { runner, calls, steered };
};

// A conversation's record as its first settle leaves it, in the shared tree; each suite states the records it reads.
export const conversationEntry = (overrides: Partial<PersistedAgent> = {}): PersistedAgent => ({
    id: "c1",
    placement: { kind: "main" },
    identity: {},
    profile: { provider: "claude", harness: "native" },
    ending: { kind: "idle" },
    postures: {},
    landing: {},
    social: { title: { text: "fix the thing", source: "derived" }, reactions: [] },
    totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns: 0, toolUses: 0, subagents: 0 },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
});

// A conversation `turns` turns in: what a turn's planner reads to decide what the opening turn alone is owed.
export const conversationAfter = (turns: number, overrides: Partial<PersistedAgent> = {}): PersistedAgent =>
    conversationEntry({ totals: { costUsd: 0, inputTokens: 0, outputTokens: 0, turns, toolUses: 0, subagents: 0 }, ...overrides });

// One agent card mid-life, nothing landed yet; IsolatedAgent (not PersistedAgent) since placement-reading code needs
// the worktree-carrying subtype. `repos` is readonly, matching what ConversationWorktree hands back.
export const isolatedAgent = (repos: readonly RepoRecord[], overrides: Partial<IsolatedAgent> = {}): IsolatedAgent => {
    const id = overrides.id ?? "c1";
    return {
        ...conversationEntry({ id }),
        placement: { kind: "worktree", branch: `agent/${id}`, repos: [...repos] },
        ...overrides,
    };
};

// What the fleet writes through, over one conversations database; a directory a leaving conversation takes with it is
// the caller's to give, and nothing on disk when it gives none.
export const fleetStoreOver = (db: ConversationsDb, units: Pick<ConversationUnits, "remove"> = { remove: async () => {} }): FleetStore => ({
    agents: sqliteAgentsStore(db),
    journal: turnJournalRows(db),
    transaction: db.transaction,
    units,
});

// Opens a turn on a conversation the way the daemon does: the `begin` event, answered once the entry's write has landed.
export const beginTurn = (conversations: Pick<ConversationActors, "send">, turn: BeginTurn, now: number): Promise<boolean> =>
    conversations.send(turn.conversationId, { kind: "begin", turn }, now).settled;

// A fleet over nothing: entries kept in an in-memory database (the real store, the real SQL), and land probes that
// never find a standing or a presence to report. Pass the store over the database a suite's other stores share.
export const memoryFleet = (store: FleetStore = fleetStoreOver(openConversationsDb(IN_MEMORY))): Fleet =>
    createFleet(
        store,
        { of: () => "idle", causesOf: () => [], refresh: async () => false, forget: () => {} },
        { of: () => undefined, refresh: async () => false, forget: () => {}, metrics: () => ({}) },
    );

// A memory fleet that also hands every conversation event to `note` as it is sent, for suites pinning what a flow tells
// a conversation, and in which order.
export const notedFleet = (note: (conversationId: string, event: ConversationEvent) => void, store?: FleetStore): Fleet => {
    const { agents, conversations } = memoryFleet(store);
    return {
        agents,
        conversations: {
            ...conversations,
            send: (conversationId, event, now) => {
                note(conversationId, event);
                return conversations.send(conversationId, event, now);
            },
        },
    };
};

// These services with every TurnStarter door running `body` over them, the way composition binds streamAgent: the
// engine's own start, resume, run and stop, around a turn the suite scripts.
export const drivenBy = (services: Services, body: TurnStarter["stream"]): Services => {
    const driven: Services = unstubbed<Services>("services", { ...services, turns: turnDoors(() => driven, body) });
    return driven;
};

// The TurnStarter port's wake door, recording what it was handed the way admission would take it: said into the live turn
// while `live`, queued while `busy` counts down (Infinity: every one until reset), a turn of its own otherwise; never
// answered while `stuck`, as a daemon dying mid-delivery.
export interface FakeTurns {
    readonly turns: Pick<TurnStarter, "say">;
    readonly steers: Steer[];
    readonly started: (TurnInput & { readonly conversationId: string })[];
    readonly queued: Said[];
    live: boolean;
    busy: number;
    stuck: boolean;
}

export const fakeTurns = (over: { readonly live?: boolean; readonly busy?: number } = {}): FakeTurns => {
    const fake: FakeTurns = {
        steers: [],
        started: [],
        queued: [],
        live: over.live === true,
        busy: over.busy ?? 0,
        stuck: false,
        turns: {
            say: async (said) => {
                if (fake.stuck) {
                    return new Promise<never>(() => undefined);
                }
                if (fake.live) {
                    fake.steers.push({ text: said.turn.prompt, voice: said.voice, ...opt("outside", said.outside) });
                    return { delivered: "steered", run: "run-live" };
                }
                if (fake.busy > 0) {
                    fake.busy -= 1;
                    fake.queued.push(said);
                    return { delivered: "queued" };
                }
                fake.started.push({ ...said.turn, ...opt("outsideWake", said.outside) });
                return { delivered: "started", run: `run-${fake.started.length}` };
            },
        },
    };
    return fake;
};
