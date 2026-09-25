import type { AgentEvent, AgentJob, AgentWatch, TurnProof } from "@intentic/sandbox-contract";
import { isolatedAgent } from "../../testing.js";
import type { JournalledTurn } from "../../agent/run/turn/turn-journal.js";
import type { PersistedAgent } from "../registry/agents-store.js";
import { type BeginTurn, type ConversationEffect, type ConversationEvent, decide, type SettleFlush } from "./conversation-decide.js";
import { hold, joined, NO_QUEUE } from "./conversation-queue.js";
import { type ConversationState, freshRuntime, idleConversation, NO_USAGE, type ParkedCard, type StopEnding } from "./conversation-state.js";

// Every transition the conversation's one writer makes, as a table: the state an event meets, what it leaves, the
// effects in the order they must run, and the answer. Pure, so each row is the whole story of one event.

const NOW = 5_000;
// A person's message; the sandbox's own turns (a resume, a follow-up, a wake) begin the same way with `byPerson: false`.
const OPENING: BeginTurn = { conversationId: "c1", isolated: true, prompt: "Fix the login bug", profile: { agent: "claude", harness: "native" }, byPerson: true };
const UNATTENDED: BeginTurn = { ...OPENING, prompt: "Picking this back up.", byPerson: false };
const ENTRY: PersistedAgent = isolatedAgent([]);
const ARCHIVED: PersistedAgent = { ...ENTRY, archivedAt: 2_000 };
const SESSIONED: PersistedAgent = { ...ENTRY, sessionId: "s-0" };
// The in-flight record a journalled run files for its turn.
const IN_FLIGHT: JournalledTurn = { kind: "turn", turn: { conversationId: "c1", prompt: "go" }, startedAt: 900, attempts: 0 };

// Every row starts from the state a new actor holds, so a field added to it later needs no edit here.
const running = (
    over: { parked?: readonly ParkedCard[]; stopping?: StopEnding } = {},
    turn: Partial<ConversationState["turn"]> = {},
): ConversationState => ({
    ...idleConversation(),
    phase: { kind: "running", startedAt: 1_000, parked: over.parked ?? [], stopping: over.stopping },
    turn: { ...freshRuntime(), lastAt: 1_000, ...turn },
});
const idle = (turn: Partial<ConversationState["turn"]> = {}, held = 0): ConversationState => ({
    ...idleConversation(),
    turn: { ...freshRuntime(), ...turn },
    land: { held },
});
const rewinding = (): ConversationState => ({ ...idleConversation(), phase: { kind: "rewinding" } });

const QUESTION: AgentEvent = { kind: "question", requestId: "q-1", questions: [] };
const PLAN: AgentEvent = { kind: "plan", requestId: "p-1", text: "# Ship the parser\n1. go" };
const FAILED: AgentEvent = { kind: "error", message: "  the runtime\n died  " };
const BROADCAST: ConversationEffect[] = [{ kind: "broadcast" }];
// What a running turn's own progress raises: a broadcast that may ride the next send.
const PROGRESS: ConversationEffect[] = [{ kind: "progress" }];
const JOB: AgentJob = { id: "j-1", label: "pnpm build", session: "agent-c1", startedAt: 1_000 };
const WATCH: AgentWatch = { id: "watch-k3f9", note: "CI green", intervalSeconds: 60, deadlineAt: 9_000 };
// A person's message waiting for the next turn, and the queue holding it.
const QUEUED = { id: "m-1", voice: "person", queuedAt: 900, turn: { conversationId: "c1", prompt: "and the docs", messageId: "m-1" } } as const;
const WAITING = joined(NO_QUEUE, QUEUED);
// What a settling turn showed of its own work, as settle-turn.ts notes it just ahead of the settle that files it.
const PROOF: TurnProof = { at: 4_000, verification: "failing", check: "pnpm test" };
const LATER_PROOF: TurnProof = { at: 4_500, verification: "verified", check: "pnpm test" };

interface Row {
    readonly name: string;
    readonly from: ConversationState;
    readonly event: ConversationEvent;
    readonly entry?: PersistedAgent;
    readonly to: ConversationState;
    readonly effects: readonly ConversationEffect[];
    readonly reply?: unknown;
}

const frame = (event: AgentEvent): ConversationEvent => ({ kind: "frame", frame: event });

const rows: readonly Row[] = [
    {
        name: "begin claims an idle conversation and holds the prompt for the session its first frame mints",
        from: idle({ checklist: [], resuming: true, landing: true }, 2),
        event: { kind: "begin", turn: OPENING },
        entry: ENTRY,
        to: {
            ...idleConversation(),
            phase: { kind: "running", startedAt: NOW, parked: [], stopping: undefined },
            turn: { ...freshRuntime(), lastAt: NOW, promptToFile: OPENING.prompt },
            land: { held: 2 },
        },
        effects: [
            { kind: "entry-opened", turn: OPENING },
            { kind: "conversation-prompt", prompt: OPENING.prompt },
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    },
    {
        name: "begin on a conversation that already has a session files the prompt under it at once",
        from: idleConversation(),
        event: { kind: "begin", turn: OPENING },
        entry: SESSIONED,
        to: {
            ...idleConversation(),
            phase: { kind: "running", startedAt: NOW, parked: [], stopping: undefined },
            turn: { ...freshRuntime(), lastAt: NOW },
        },
        effects: [
            { kind: "entry-opened", turn: OPENING },
            { kind: "session-prompt", sessionId: "s-0", prompt: OPENING.prompt },
            { kind: "conversation-prompt", prompt: OPENING.prompt },
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    },
    {
        name: "begin writes the run's journal row with the entry that opens the turn, one write for both",
        from: { ...idleConversation(), journal: { entry: IN_FLIGHT, written: false } },
        event: { kind: "begin", turn: OPENING },
        entry: SESSIONED,
        to: {
            ...idleConversation(),
            phase: { kind: "running", startedAt: NOW, parked: [], stopping: undefined },
            turn: { ...freshRuntime(), lastAt: NOW },
            journal: { entry: IN_FLIGHT, written: true },
        },
        effects: [
            { kind: "entry-opened", turn: OPENING, inFlight: IN_FLIGHT },
            { kind: "session-prompt", sessionId: "s-0", prompt: OPENING.prompt },
            { kind: "conversation-prompt", prompt: OPENING.prompt },
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    },
    {
        name: "a run's journal row filed before its turn begins is held for that begin, and written by nothing else",
        from: idleConversation(),
        event: { kind: "journalled", entry: IN_FLIGHT },
        to: { ...idleConversation(), journal: { entry: IN_FLIGHT, written: false } },
        effects: [],
    },
    {
        name: "once the turn's begin has written the row, each newer version of it is written through",
        from: { ...running(), journal: { entry: IN_FLIGHT, written: true } },
        event: { kind: "journalled", entry: { ...IN_FLIGHT, sessionId: "s-1" } },
        to: { ...running(), journal: { entry: { ...IN_FLIGHT, sessionId: "s-1" }, written: true } },
        effects: [{ kind: "journal-written", entry: { ...IN_FLIGHT, sessionId: "s-1" } }],
    },
    {
        name: "a run that is over takes its written row off the journal",
        from: { ...idleConversation(), journal: { entry: IN_FLIGHT, written: true } },
        event: { kind: "unjournalled" },
        to: idleConversation(),
        effects: [{ kind: "journal-cleared" }],
    },
    {
        name: "a run that never began has no row to take off, and leaves nothing held for the next begin",
        from: { ...idleConversation(), journal: { entry: IN_FLIGHT, written: false } },
        event: { kind: "unjournalled" },
        to: idleConversation(),
        effects: [],
    },
    {
        name: "a begin refused under a live turn leaves another run's held row where it is",
        from: { ...running(), journal: { entry: IN_FLIGHT, written: false } },
        event: { kind: "begin", turn: OPENING },
        entry: ENTRY,
        to: { ...running(), journal: { entry: IN_FLIGHT, written: false } },
        effects: [],
        reply: "busy",
    },
    {
        name: "begin under a live turn is refused",
        from: running(),
        event: { kind: "begin", turn: OPENING },
        entry: ENTRY,
        to: running(),
        effects: [],
        reply: "busy",
    },
    {
        name: "begin under a rewind is refused",
        from: rewinding(),
        event: { kind: "begin", turn: OPENING },
        entry: ENTRY,
        to: rewinding(),
        effects: [],
        reply: "busy",
    },
    {
        name: "a begin nobody sent is turned away from an archived conversation, which opens nothing and stays archived",
        from: idle(),
        event: { kind: "begin", turn: UNATTENDED },
        entry: ARCHIVED,
        to: idle(),
        effects: [],
        reply: "archived",
    },
    {
        name: "an archived conversation says so to a begin nobody sent even while a rewind holds it, since waiting cannot help",
        from: rewinding(),
        event: { kind: "begin", turn: UNATTENDED },
        entry: ARCHIVED,
        to: rewinding(),
        effects: [],
        reply: "archived",
    },
    {
        name: "a person's begin opens an archived conversation, the entry it opens coming back onto the board",
        from: idleConversation(),
        event: { kind: "begin", turn: OPENING },
        entry: ARCHIVED,
        to: {
            ...idleConversation(),
            phase: { kind: "running", startedAt: NOW, parked: [], stopping: undefined },
            turn: { ...freshRuntime(), lastAt: NOW, promptToFile: OPENING.prompt },
        },
        effects: [
            { kind: "entry-opened", turn: OPENING },
            { kind: "conversation-prompt", prompt: OPENING.prompt },
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    },
    {
        name: "a begin nobody sent claims a conversation that is not archived",
        from: idleConversation(),
        event: { kind: "begin", turn: UNATTENDED },
        entry: ENTRY,
        to: {
            ...idleConversation(),
            phase: { kind: "running", startedAt: NOW, parked: [], stopping: undefined },
            turn: { ...freshRuntime(), lastAt: NOW, promptToFile: UNATTENDED.prompt },
        },
        effects: [
            { kind: "entry-opened", turn: UNATTENDED },
            { kind: "conversation-prompt", prompt: UNATTENDED.prompt },
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    },
    {
        name: "asked ahead of a run, an archived conversation says it would turn away a turn nobody sent",
        from: idle(),
        event: { kind: "open-asked", byPerson: false },
        entry: ARCHIVED,
        to: idle(),
        effects: [],
        reply: false,
    },
    {
        name: "asked ahead of a run, an archived conversation would open for a person",
        from: idle(),
        event: { kind: "open-asked", byPerson: true },
        entry: ARCHIVED,
        to: idle(),
        effects: [],
        reply: true,
    },
    {
        name: "asked ahead of a run, a conversation on the board would open for anyone, whatever holds it now",
        from: running(),
        event: { kind: "open-asked", byPerson: false },
        entry: ENTRY,
        to: running(),
        effects: [],
        reply: true,
    },
    {
        name: "asked ahead of a run, a conversation with no entry yet would open for anyone",
        from: idleConversation(),
        event: { kind: "open-asked", byPerson: false },
        to: idleConversation(),
        effects: [],
        reply: true,
    },
    {
        name: "a card raised on a live turn parks it",
        from: running(),
        event: frame(QUESTION),
        to: running({ parked: [{ requestId: "q-1", kind: "question" }] }, { lastAt: NOW }),
        effects: BROADCAST,
    },
    {
        name: "a card raised again under the same id replaces itself rather than parking twice",
        from: running({
            parked: [
                { requestId: "q-1", kind: "question" },
                { requestId: "r-2", kind: "permission" },
            ],
        }),
        event: frame({ kind: "plan", requestId: "q-1", text: "no heading" }),
        to: running(
            {
                parked: [
                    { requestId: "q-1", kind: "plan" },
                    { requestId: "r-2", kind: "permission" },
                ],
            },
            { lastAt: NOW },
        ),
        effects: [{ kind: "title-planned", text: "no heading" }, { kind: "broadcast" }],
    },
    {
        name: "a plan raised behind a stop names the job but parks nothing and publishes nothing",
        from: running({ stopping: "stopped" }),
        event: frame(PLAN),
        to: running({ stopping: "stopped" }, { lastAt: NOW }),
        effects: [{ kind: "title-planned", text: "# Ship the parser\n1. go" }],
    },
    { name: "a card raised with no turn live has nowhere to park", from: idle(), event: frame(QUESTION), to: idle({ lastAt: NOW }), effects: [] },
    {
        name: "a card's own release takes it off the board",
        from: running({ parked: [{ requestId: "q-1", kind: "question" }] }),
        event: frame({ kind: "resolved", requestId: "q-1" }),
        to: running({}, { lastAt: NOW }),
        effects: BROADCAST,
    },
    {
        name: "a release for a card nobody raised publishes nothing",
        from: running(),
        event: frame({ kind: "resolved", requestId: "q-9" }),
        to: running({}, { lastAt: NOW }),
        effects: [],
    },
    {
        name: "the session frame binds the session and files the prompt waiting for it, without a broadcast",
        from: running({}, { promptToFile: "Fix it" }),
        event: frame({ kind: "session", sessionId: "s-1", account: "acct" }),
        to: running({}, { lastAt: NOW, sessionId: "s-1" }),
        effects: [
            { kind: "session-bound", sessionId: "s-1", account: "acct" },
            { kind: "session-prompt", sessionId: "s-1", prompt: "Fix it" },
        ],
    },
    {
        name: "usage accumulates onto the turn's books",
        from: running({}, { usage: { ...NO_USAGE, costUsd: 0.5, inputTokens: 10 } }),
        event: frame({ kind: "usage", costUsd: 0.25, inputTokens: 5, outputTokens: 7 }),
        to: running({}, { lastAt: NOW, usage: { ...NO_USAGE, costUsd: 0.75, inputTokens: 15, outputTokens: 7 } }),
        effects: PROGRESS,
    },
    {
        name: "half a cache pair names no deadline, so the last one stands",
        from: running({}, { promptCache: { at: 1, ttlMs: 300_000 } }),
        event: frame({ kind: "context_usage", tokens: 9_000, contextWindow: 200_000, cachedAt: 7 }),
        to: running({}, { lastAt: NOW, contextTokens: 9_000, contextWindow: 200_000, promptCache: { at: 1, ttlMs: 300_000 } }),
        effects: PROGRESS,
    },
    {
        name: "a whole cache pair replaces the deadline",
        from: running(),
        event: frame({ kind: "context_usage", tokens: 9_000, contextWindow: 200_000, cachedAt: 7, cacheTtlMs: 3_600_000 }),
        to: running({}, { lastAt: NOW, contextTokens: 9_000, contextWindow: 200_000, promptCache: { at: 7, ttlMs: 3_600_000 } }),
        effects: PROGRESS,
    },
    {
        name: "a tool call counts, and keeps the checklist step the card is showing",
        from: running({}, { activity: { tool: "Read", todo: "write tests" } }),
        event: frame({ kind: "tool_call", id: "t", name: "Edit", category: "edit", status: "in_progress", target: "src/a.ts" }),
        to: running({}, { lastAt: NOW, activity: { tool: "Edit", target: "src/a.ts", todo: "write tests" }, usage: { ...NO_USAGE, toolUses: 1 } }),
        effects: PROGRESS,
    },
    {
        name: "a checklist frame is the whole list, and names the step in progress",
        from: running(),
        event: frame({
            kind: "todos",
            items: [
                { content: "a", status: "completed" },
                { content: "b", status: "in_progress" },
            ],
        }),
        to: running(
            {},
            {
                lastAt: NOW,
                activity: { todo: "b" },
                checklist: [
                    { content: "a", status: "completed" },
                    { content: "b", status: "in_progress" },
                ],
            },
        ),
        effects: PROGRESS,
    },
    {
        name: "a checklist with nothing in progress still leaves an activity, empty",
        from: running(),
        event: frame({ kind: "todos", items: [] }),
        to: running({}, { lastAt: NOW, activity: {}, checklist: [] }),
        effects: PROGRESS,
    },
    {
        name: "a child's birth is counted",
        from: running(),
        event: frame({ kind: "subagent", id: "k", subagentKind: "spawned" }),
        to: running({}, { lastAt: NOW, usage: { ...NO_USAGE, subagents: 1 } }),
        effects: PROGRESS,
    },
    {
        name: "a child's progress publishes nothing",
        from: running(),
        event: frame({ kind: "subagent_update", id: "k" }),
        to: running({}, { lastAt: NOW }),
        effects: [],
    },
    {
        name: "a child's status change publishes",
        from: running(),
        event: frame({ kind: "subagent_update", id: "k", status: "completed" }),
        to: running({}, { lastAt: NOW }),
        effects: PROGRESS,
    },
    {
        name: "a compaction is filed, not published",
        from: running(),
        event: frame({ kind: "compact", trigger: "auto" }),
        to: running({}, { lastAt: NOW }),
        effects: [{ kind: "compacted" }],
    },
    {
        name: "a failure the daemon will re-run reads as work in progress, quietly",
        from: running(),
        event: frame({ kind: "error", code: "provider-outage", message: "down", autoResume: "scheduled" }),
        to: running({}, { lastAt: NOW, resuming: true }),
        effects: [],
    },
    {
        name: "a spent allowance is a failure even when scheduled, with every limit field from the one frame",
        from: running(),
        event: frame({
            kind: "error",
            code: "rate_limit",
            message: "spent",
            autoResume: "scheduled",
            resetsAt: 99,
            held: { ran: true, moving: "acct-2" },
        }),
        to: running(
            {},
            {
                lastAt: NOW,
                failure: { kind: "limited", failure: "spent", resetsAt: 99, held: true, scheduled: true, moving: "acct-2" },
            },
        ),
        effects: PROGRESS,
    },
    {
        name: "an uncoded failure keeps one bounded line of its sentence",
        from: running(),
        event: frame(FAILED),
        to: running(
            {},
            {
                lastAt: NOW,
                failure: { kind: "failed", failure: "the runtime died" },
            },
        ),
        effects: PROGRESS,
    },
    {
        name: "a delta moves only the card's recency",
        from: running(),
        event: frame({ kind: "delta", text: "hi" }),
        to: running({}, { lastAt: NOW }),
        effects: [],
    },
    {
        name: "a stop lands at once, taking every parked card with it",
        from: running({ parked: [{ requestId: "q-1", kind: "question" }] }),
        event: { kind: "stop", ending: "dismissed" },
        to: running({ stopping: "dismissed" }),
        effects: BROADCAST,
    },
    {
        name: "a second stop changes nothing",
        from: running({ stopping: "stopped" }),
        event: { kind: "stop", ending: "dismissed" },
        to: running({ stopping: "stopped" }),
        effects: [],
    },
    { name: "a stop with no live turn says nothing", from: idle(), event: { kind: "stop", ending: "stopped" }, to: idle(), effects: [] },
    {
        name: "a noted proof waits on the turn for the settle to file it, quietly",
        from: running(),
        event: { kind: "proof-noted", proof: PROOF },
        to: running({}, { proof: PROOF }),
        effects: [],
    },
    {
        name: "a second note replaces the first: the settle files the last reading",
        from: running({}, { proof: PROOF }),
        event: { kind: "proof-noted", proof: LATER_PROOF },
        to: running({}, { proof: LATER_PROOF }),
        effects: [],
    },
    {
        name: "a begin starts the turn's books without the last turn's proof",
        from: idle({ proof: PROOF }),
        event: { kind: "begin", turn: OPENING },
        entry: SESSIONED,
        to: {
            ...idleConversation(),
            phase: { kind: "running", startedAt: NOW, parked: [], stopping: undefined },
            turn: { ...freshRuntime(), lastAt: NOW },
        },
        effects: [
            { kind: "entry-opened", turn: OPENING },
            { kind: "session-prompt", sessionId: "s-0", prompt: OPENING.prompt },
            { kind: "conversation-prompt", prompt: OPENING.prompt },
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    },
    { name: "a new turn starts unwatched", from: { ...idle(), steered: true }, event: { kind: "turn-registered" }, to: idle(), effects: [] },
    {
        name: "a person's words mark the turn watched",
        from: running(),
        event: { kind: "person-steered" },
        to: { ...running(), steered: true },
        effects: [],
    },
    {
        name: "a steered message's box is reserved empty, at the next position",
        from: { ...running(), steers: { next: 4, slots: [{ id: 3, checkpoint: undefined }] } },
        event: { kind: "steer-reserved" },
        to: {
            ...running(),
            steers: {
                next: 5,
                slots: [
                    { id: 3, checkpoint: undefined },
                    { id: 4, checkpoint: undefined },
                ],
            },
        },
        effects: [],
        reply: 4,
    },
    {
        name: "a capture fills its own box however late it lands",
        from: {
            ...running(),
            steers: {
                next: 5,
                slots: [
                    { id: 3, checkpoint: undefined },
                    { id: 4, checkpoint: undefined },
                ],
            },
        },
        event: { kind: "steer-captured", slot: 3, checkpoint: { kind: "tree", snapshot: "snap-3" } },
        to: {
            ...running(),
            steers: {
                next: 5,
                slots: [
                    { id: 3, checkpoint: { kind: "tree", snapshot: "snap-3" } },
                    { id: 4, checkpoint: undefined },
                ],
            },
        },
        effects: [],
    },
    {
        name: "a capture whose box was already taken fills nothing",
        from: { ...running(), steers: { next: 5, slots: [] } },
        event: { kind: "steer-captured", slot: 3, checkpoint: { kind: "tree", snapshot: "snap-3" } },
        to: { ...running(), steers: { next: 5, slots: [] } },
        effects: [],
    },
    {
        name: "the settle takes every box in the order reserved, and leaves none behind",
        from: {
            ...idle(),
            steers: {
                next: 2,
                slots: [
                    { id: 0, checkpoint: undefined },
                    { id: 1, checkpoint: { kind: "tree", snapshot: "snap-1" } },
                ],
            },
        },
        event: { kind: "steers-taken" },
        to: { ...idle(), steers: { next: 2, slots: [] } },
        effects: [],
        reply: [undefined, { kind: "tree", snapshot: "snap-1" }],
    },
    {
        name: "a restored card's grant is held for the resumed turn",
        from: running(),
        event: { kind: "grant-restored", tool: "Bash", always: true },
        to: { ...running(), grant: { tool: "Bash", always: true, grantedAt: NOW } },
        effects: [],
    },
    {
        name: "the gate takes a fresh grant for its tool, once",
        from: { ...running(), grant: { tool: "Bash", always: false, grantedAt: NOW - 10 * 60_000 } },
        event: { kind: "grant-taken", tool: "Bash" },
        to: running(),
        effects: [],
        reply: { always: false },
    },
    {
        name: "a grant for another tool is left for its own",
        from: { ...running(), grant: { tool: "Bash", always: false, grantedAt: NOW } },
        event: { kind: "grant-taken", tool: "Edit" },
        to: { ...running(), grant: { tool: "Bash", always: false, grantedAt: NOW } },
        effects: [],
    },
    {
        name: "a grant past its ten minutes answers nothing, and stays until replaced",
        from: { ...running(), grant: { tool: "Bash", always: false, grantedAt: NOW - 10 * 60_000 - 1 } },
        event: { kind: "grant-taken", tool: "Bash" },
        to: { ...running(), grant: { tool: "Bash", always: false, grantedAt: NOW - 10 * 60_000 - 1 } },
        effects: [],
    },
    {
        name: "a job list replaces the card's whole mid-turn, and publishes it",
        from: { ...running(), jobs: [{ ...JOB, id: "j-0" }] },
        event: { kind: "jobs-shown", jobs: [JOB] },
        to: { ...running(), jobs: [JOB] },
        effects: BROADCAST,
    },
    {
        name: "an emptied job list clears the card between turns, and publishes that too",
        from: { ...idle(), jobs: [{ ...JOB, endedAt: 2_000, exitCode: 0 }] },
        event: { kind: "jobs-shown", jobs: [] },
        to: idle(),
        effects: BROADCAST,
    },
    {
        name: "an armed watch goes on a resting card, and publishes it",
        from: idle(),
        event: { kind: "watches-shown", watches: [WATCH] },
        to: { ...idle(), watches: [WATCH] },
        effects: BROADCAST,
    },
    {
        name: "the last watch firing empties the card's list, and publishes that",
        from: { ...running(), watches: [WATCH] },
        event: { kind: "watches-shown", watches: [] },
        to: running(),
        effects: BROADCAST,
    },
    {
        name: "a loop's standing replaces the last one on the card, and publishes it",
        from: { ...running(), loop: { state: "running", iteration: 1, maxIterations: 5, goal: "green suite" } },
        event: { kind: "loop-shown", loop: { state: "exhausted", iteration: 5, maxIterations: 5, goal: "green suite" } },
        to: { ...running(), loop: { state: "exhausted", iteration: 5, maxIterations: 5, goal: "green suite" } },
        effects: BROADCAST,
    },
    {
        name: "a workflow step names its run on a card that had none, and publishes it",
        from: idle(),
        event: { kind: "workflow-shown", workflow: { runId: "run-1", name: "ship", step: "Build", index: 2, total: 3 } },
        to: { ...idle(), workflow: { runId: "run-1", name: "ship", step: "Build", index: 2, total: 3 } },
        effects: BROADCAST,
    },
    { name: "a promised resume is held quietly", from: idle(), event: { kind: "resume-promised" }, to: idle({ resuming: true }), effects: [] },
    {
        name: "an abandon under a live turn does not take",
        from: running({}, { resuming: true }),
        event: { kind: "resume-abandoned", reason: "x" },
        entry: ENTRY,
        to: running({}, { resuming: true }),
        effects: [],
        reply: false,
    },
    {
        name: "an abandon with no wait to end is already over",
        from: idle(),
        event: { kind: "resume-abandoned", reason: "x" },
        entry: ENTRY,
        to: idle(),
        effects: [],
        reply: true,
    },
    {
        name: "an abandon for a conversation with no entry writes nothing",
        from: idle({ resuming: true }),
        event: { kind: "resume-abandoned", reason: "x" },
        to: idle({ resuming: true }),
        effects: [],
        reply: true,
    },
    {
        name: "an abandon ends the wait and settles the card into the failure it held open",
        from: idle({ resuming: true }),
        event: { kind: "resume-abandoned", reason: " gone\n for good " },
        entry: ENTRY,
        to: idle(),
        effects: [{ kind: "entry-abandoned", failure: "gone for good" }, { kind: "persist" }, { kind: "broadcast" }],
        reply: true,
    },
    {
        name: "the first land lease shows the card landing",
        from: idle(),
        event: { kind: "land-leased" },
        to: idle({ landing: true }, 1),
        effects: BROADCAST,
    },
    {
        name: "a queued land lease publishes nothing new",
        from: idle({ landing: true }, 1),
        event: { kind: "land-leased" },
        to: idle({ landing: true }, 2),
        effects: [],
    },
    {
        name: "a release with a land still queued keeps the card landing",
        from: idle({ landing: true }, 2),
        event: { kind: "land-released" },
        to: idle({ landing: true }, 1),
        effects: [],
    },
    {
        name: "the last release hides the lease",
        from: idle({ landing: true }, 1),
        event: { kind: "land-released" },
        to: idle({}, 0),
        effects: BROADCAST,
    },
    { name: "a rewind claims an idle conversation", from: idle(), event: { kind: "rewind-leased" }, to: rewinding(), effects: [], reply: true },
    { name: "a rewind is refused under a live turn", from: running(), event: { kind: "rewind-leased" }, to: running(), effects: [], reply: false },
    { name: "a rewind's release frees the conversation", from: rewinding(), event: { kind: "rewind-released" }, to: idleConversation(), effects: [] },
    {
        name: "a cleared session drops the live turn's pending id and the entry's",
        from: running({}, { sessionId: "s-1" }),
        event: { kind: "session-cleared" },
        entry: ENTRY,
        to: running(),
        effects: [{ kind: "session-dropped" }, { kind: "persist" }, { kind: "broadcast" }],
    },
    {
        name: "a cleared session on no entry changes nothing",
        from: running({}, { sessionId: "s-1" }),
        event: { kind: "session-cleared" },
        to: running({}, { sessionId: "s-1" }),
        effects: [],
    },
    {
        name: "a message joining the queue is written onto the entry and shown",
        from: idle(),
        event: { kind: "queue-joined", item: QUEUED },
        to: { ...idle(), queue: WAITING },
        effects: [{ kind: "queue-written", queue: WAITING }, { kind: "persist" }, { kind: "broadcast" }],
    },
    {
        name: "a stop holds what waits, for everyone, and writes the hold onto the entry",
        from: { ...running(), queue: WAITING },
        event: { kind: "stop", ending: "stopped" },
        to: { ...running({ stopping: "stopped" }), queue: hold(WAITING, "stopped") },
        effects: [{ kind: "queue-written", queue: hold(WAITING, "stopped") }, { kind: "persist" }, { kind: "broadcast" }],
    },
    {
        name: "a begin that opens a new entry writes onto it what already waits: a message sent while the first turn started",
        from: idleConversation(WAITING),
        event: { kind: "begin", turn: OPENING },
        to: {
            ...idleConversation(WAITING),
            phase: { kind: "running", startedAt: NOW, parked: [], stopping: undefined },
            turn: { ...freshRuntime(), lastAt: NOW, promptToFile: OPENING.prompt },
        },
        effects: [
            { kind: "entry-opened", turn: OPENING },
            { kind: "queue-written", queue: WAITING },
            { kind: "conversation-prompt", prompt: OPENING.prompt },
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    },
    {
        name: "a rewording made against an older copy changes nothing, and says it was stale",
        from: { ...idle(), queue: WAITING },
        event: { kind: "queue-edited", id: "m-1", revision: 0, text: "and the tests" },
        to: { ...idle(), queue: WAITING },
        effects: [],
        reply: "stale",
    },
    {
        name: "begin takes a live keep-warm hold into the turn, where its first cache reading names it",
        from: { ...idle(), keepWarm: { since: 1_000, until: 90_000, refreshes: 3, readTokens: 250_000 } },
        event: { kind: "begin", turn: OPENING },
        entry: ENTRY,
        to: {
            ...idleConversation(),
            phase: { kind: "running", startedAt: NOW, parked: [], stopping: undefined },
            turn: { ...freshRuntime(), lastAt: NOW, promptToFile: OPENING.prompt, keptWarm: { forMs: NOW - 1_000, refreshes: 3 } },
        },
        effects: [
            { kind: "entry-opened", turn: OPENING },
            { kind: "conversation-prompt", prompt: OPENING.prompt },
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    },
    {
        name: "begin drops a hold that already ended, with no receipt to give",
        from: { ...idle(), keepWarm: { since: 1_000, until: 90_000, refreshes: 1, ended: { at: 2_000, reason: "allowance" } } },
        event: { kind: "begin", turn: OPENING },
        entry: ENTRY,
        to: {
            ...idleConversation(),
            phase: { kind: "running", startedAt: NOW, parked: [], stopping: undefined },
            turn: { ...freshRuntime(), lastAt: NOW, promptToFile: OPENING.prompt },
        },
        effects: [
            { kind: "entry-opened", turn: OPENING },
            { kind: "conversation-prompt", prompt: OPENING.prompt },
            { kind: "broadcast" },
            { kind: "persist" },
        ],
        reply: "begun",
    },
    {
        name: "arming starts a hold now, and says it was the sandbox's own when it was",
        from: idle(),
        event: { kind: "keep-warm-armed", until: 60_000, auto: true },
        to: { ...idle(), keepWarm: { since: NOW, until: 60_000, refreshes: 0, auto: true } },
        effects: BROADCAST,
    },
    {
        name: "re-arming a live hold moves its deadline and keeps its start and its count",
        from: { ...idle(), keepWarm: { since: 1_000, until: 60_000, refreshes: 2, readTokens: 9 } },
        event: { kind: "keep-warm-armed", until: 80_000, auto: false },
        to: { ...idle(), keepWarm: { since: 1_000, until: 80_000, refreshes: 2, readTokens: 9 } },
        effects: BROADCAST,
    },
    {
        name: "re-arming an ended hold starts over",
        from: { ...idle(), keepWarm: { since: 1_000, until: 60_000, refreshes: 2, ended: { at: 3_000, reason: "cold" } } },
        event: { kind: "keep-warm-armed", until: 80_000, auto: false },
        to: { ...idle(), keepWarm: { since: NOW, until: 80_000, refreshes: 0 } },
        effects: BROADCAST,
    },
    {
        name: "a refresh restarts the cache's clock and counts itself on the hold",
        from: { ...idle({ promptCache: { at: 1_000, ttlMs: 3_600_000 } }), keepWarm: { since: 1_000, until: 90_000, refreshes: 0 } },
        event: { kind: "keep-warm-refreshed", at: 4_000, ttlMs: 3_600_000, readTokens: 240_000 },
        to: { ...idle({ promptCache: { at: 4_000, ttlMs: 3_600_000 } }), keepWarm: { since: 1_000, until: 90_000, refreshes: 1, readTokens: 240_000 } },
        effects: BROADCAST,
    },
    {
        name: "a refresh that lands after a turn took the hold writes nothing",
        from: running(),
        event: { kind: "keep-warm-refreshed", at: 4_000, ttlMs: 3_600_000, readTokens: 240_000 },
        to: running(),
        effects: [],
    },
    {
        name: "an ending is recorded once, with its reason and specifics",
        from: { ...idle(), keepWarm: { since: 1_000, until: 90_000, refreshes: 2 } },
        event: { kind: "keep-warm-ended", reason: "changed", detail: "version" },
        to: { ...idle(), keepWarm: { since: 1_000, until: 90_000, refreshes: 2, ended: { at: NOW, reason: "changed", detail: "version" } } },
        effects: BROADCAST,
    },
    {
        name: "a second ending leaves the first standing",
        from: { ...idle(), keepWarm: { since: 1_000, until: 90_000, refreshes: 2, ended: { at: 3_000, reason: "cold" } } },
        event: { kind: "keep-warm-ended", reason: "failed" },
        to: { ...idle(), keepWarm: { since: 1_000, until: 90_000, refreshes: 2, ended: { at: 3_000, reason: "cold" } } },
        effects: [],
    },
    {
        name: "dropping a hold clears it for every card",
        from: { ...idle(), keepWarm: { since: 1_000, until: 90_000, refreshes: 2 } },
        event: { kind: "keep-warm-dropped" },
        to: idle(),
        effects: BROADCAST,
    },
    {
        name: "a turn that left a request to replay says so to every card, once",
        from: idle(),
        event: { kind: "replay-noted", replayable: true },
        to: idle({ replayable: true }),
        effects: BROADCAST,
    },
];

describe("decide", () => {
    test.each(rows.map((row) => [row.name, row] as const))("%s", (_name, row) => {
        const decision = decide<ConversationEvent>(row.from, row.event, NOW, row.entry);
        expect(decision.state).toStrictEqual(row.to);
        expect(decision.effects).toStrictEqual(row.effects);
        expect(decision.reply as unknown).toStrictEqual(row.reply);
    });
});

// The settle is the one event whose effects carry the turn's whole measure, so its flush is spelled out per ending.
describe("the settle", () => {
    const books = {
        sessionId: "s-1",
        usage: { costUsd: 0.5, inputTokens: 10, outputTokens: 3, toolUses: 2, subagents: 1 },
        checklist: [{ content: "a", status: "pending" as const }],
        proof: PROOF,
    };
    const flushOf = (decision: ReturnType<typeof decide>): SettleFlush | undefined => {
        const settled = decision.effects.find((effect) => effect.kind === "entry-settled");
        return settled?.kind === "entry-settled" ? settled.flush : undefined;
    };

    test("a clean turn goes idle, hands its books to the entry and zeroes them, keeping what the card still shows", () => {
        const decision = decide(running({}, { ...books, activity: { tool: "Edit" }, landing: true }), { kind: "settle" }, NOW, ENTRY);
        expect(decision.state).toStrictEqual({ ...idle({ lastAt: 1_000, checklist: books.checklist, activity: { tool: "Edit" }, landing: true }) });
        expect(flushOf(decision)).toStrictEqual({ ranTurn: true, stopped: undefined, ending: "clean", failure: undefined, ...books });
        expect(decision.effects.map((effect) => effect.kind)).toEqual(["entry-settled", "persist", "reprobe", "broadcast"]);
    });

    test("a stopped turn is cut short, and says which ending it chose", () => {
        const decision = decide(running({ stopping: "stopped" }), { kind: "settle" }, NOW, ENTRY);
        expect(flushOf(decision)).toMatchObject({ ranTurn: true, stopped: "stopped", ending: "cut" });
    });

    test("a failed turn is cut short, and carries its failure", () => {
        const failure = { kind: "failed", failure: "died" } as const;
        const decision = decide(running({}, { failure }), { kind: "settle" }, NOW, ENTRY);
        expect(flushOf(decision)).toMatchObject({ ranTurn: true, ending: "cut", failure });
        expect(decision.state.turn.failure).toBeUndefined();
    });

    test("a settle with no turn under it (a manual land) counts none and learns nothing", () => {
        const decision = decide(idle({ resuming: true }), { kind: "settle" }, NOW, ENTRY);
        expect(flushOf(decision)).toStrictEqual({
            ranTurn: false,
            stopped: undefined,
            ending: "none",
            failure: undefined,
            usage: NO_USAGE,
            sessionId: undefined,
            checklist: undefined,
            proof: undefined,
        });
        expect(decision.state).toStrictEqual(idle({ resuming: true }));
    });

    test("a settle under a rewind leaves the rewind holding the conversation", () => {
        expect(decide(rewinding(), { kind: "settle" }, NOW, ENTRY).state.phase).toStrictEqual({ kind: "rewinding" });
    });

    test("a settle for a conversation whose entry is gone writes nothing and keeps the books", () => {
        const decision = decide(running({}, books), { kind: "settle" }, NOW, undefined);
        expect(decision.state).toStrictEqual(idle({ lastAt: 1_000, ...books }));
        expect(decision.effects).toStrictEqual([{ kind: "reprobe" }, { kind: "broadcast" }]);
    });
});
