import { errorMessage } from "@intentic/base/errors";
import type { WorkPlace } from "../../workload/resource-budget.js";
import { worktreeOf } from "../../conversations/registry/agents-store.js";
import type { AgentEvent, AgentHarness, AgentProvider, AskQuestion, ChildAgentAsk, ChildMove, ChildRun, ResumeReason, TurnProfile } from "@intentic/sandbox-contract";
import { capabilitiesOf, childRunOf, DEFAULT_HARNESS, newConversationId, PROVIDERS, sameChildRun } from "@intentic/sandbox-contract";
import { cardDeps, raiseRequest } from "../../conversations/actor/card-offers.js";
import { type Holding, type LiveRun, liveRunOf } from "../../conversations/actor/conversation-holdings.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Services } from "../../composition.js";
import { steerTurn } from "../checkpoints/agent-steering.js";
import { childSpawn } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { conversationTaintSource, markConversationTaint } from "../../guard/turn-taint.js";
import { killCauseOf, killNote, runtimeKilled } from "./child-death.js";
import { noteChildWork } from "./child-verification.js";
import { type SpawnableProvider, spawnableProviders } from "./spawn-catalog.js";
import {
    markSubagentEndingReported,
    noteSpawnedChild,
    openSpawnedChild,
    settleSpawnedChild,
    type SpawnedChildBirth,
    subagentEndingReported,
    type SubagentTurn,
    type SubagentWaitOptions,
} from "./subagents.js";
import { bookedRerunWords, sayToParent } from "./child-lands.js";
import { waitForWork, type WorkWaitOutcome } from "./work-wait.js";
import { spokenBy } from "../../seams/turn-speaker.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { opt } from "../../opt.js";
import { credentialsTravel, placeFanOut } from "../../runners/runner-scheduler.js";
import { runnerSummaries } from "../../runners/runner-peer.js";

// Spawns, steers and answers full agents from inside a turn, on any connected provider; a child is an ordinary
// conversation on the same turn pump, queued until the box has memory for it. A parked question is the parent's to
// answer; a permission or plan hold is the owner's alone. A child outlives its parent's own turn.

/**
 * What a parent is told as its child starts: a box short of memory queues it first, and `wait` covers that too. What
 * the owner changed on the gate's card, when they did, leads, since it is what the parent must not report wrongly.
 */
export const spawnedNote = (id: string, note?: string, held = false): string =>
    held
        ? `${note ?? ""} Supervise it with wait(target: "${id}").`.trim()
        : `${note === undefined ? "" : `${note} `}Started; on a box short of memory it waits as pending until there is room. Supervise it with wait(target: "${id}").`;

// Chars of the child's closing text kept inline on the roster row; the full text is in its own transcript.
const REPORT_KEPT = 2_000;

export interface ChildSpawnSpec {
    readonly prompt: string;
    // Shown on the roster row and as the child's title; falls back to the prompt's head if omitted.
    readonly description?: string;
    // Required with `model`, taken verbatim; spawn-catalog.ts is advisory, not a gate.
    readonly provider: AgentProvider;
    readonly model: string;
    readonly harness?: AgentHarness;
    readonly effort?: string;
    // Named only by an owner re-pointing the child on the gate's card; no door lets the agent set them.
    readonly thinking?: boolean;
    readonly fast?: boolean;
    readonly account?: string;
    // Runner id, or "here" to pin this sandbox; absent lets the fleet scheduler place it.
    readonly on?: string;
}

export interface ChildParent {
    readonly conversationId: string;
    // Parent turn's working tree path, as the roster handle sees it.
    readonly cwd: string;
}

export type ChildSpawnResult =
    // `id` is the child's conversation id: also the roster record's id and the wait tool's target. `note` says what the
    // owner changed before allowing it, so the parent's report names the model that actually did the work, or, `held`,
    // that the owner is still being asked.
    { readonly ok: true; readonly id: string; readonly note?: string; readonly held?: true } | { readonly ok: false; readonly message: string };

export type ChildActionResult = { readonly ok: true; readonly note?: string } | { readonly ok: false; readonly message: string };

// Full card a child is parked on, not just a summary; lets `answer` show real options and enforce the kind rule.
export interface PendingChildCard {
    readonly kind: "question" | "permission" | "plan";
    readonly requestId: string;
    readonly questions?: readonly AskQuestion[];
}

// Everything known about one child, keyed by its conversation id. `spec`/`sessionId` are what a follow-up resumes with;
// `pending` is the escalation ladder's state. In-memory: dies with the daemon.
interface ChildRecord {
    readonly parent: string;
    readonly spec: ChildSpawnSpec;
    // What every turn of this child runs as, resolved once at spawn, so a follow-up never drifts to another model.
    readonly profile: TurnProfile;
    readonly depth: number;
    readonly cwd: string;
    sessionId: string | undefined;
    running: boolean;
    // When `running` was last set; invariant.ts compares this to tell a not-yet-started record from a stale one.
    startedAt: number;
    pending: PendingChildCard | undefined;
    // Waiting for memory before its turn starts: `running`, with no turn yet to steer.
    queued: boolean;
    // Waiting for a turn somebody else started on its conversation to end before this one starts: `running`, with no
    // turn of the parent's to steer either.
    behind: boolean;
    // What of it waits on the owner's answer to a card: its start, or the parent's last message to it.
    held: "start" | "message" | undefined;
    // The OOM killer's count as its current turn started, so its ending can tell a kill from its own failure.
    oomKillsAtStart: number | undefined;
}

// A spawned child's record, held by its parent and filed about the child, so either one's dispose takes it.
const CHILDREN: Holding<ChildRecord> = { name: "children" };
// A parent's child turns, live and lifetime, held by the parent under its own id.
const SEATS: Holding<{ readonly live: number; readonly total: number }> = { name: "child seats" };
// The supervisor a turn armed for the `/children` routes, which have no tool mount to gate; held under its own id.
const SUPERVISORS: Holding<ChildSupervisor> = { name: "child supervisors" };
// The owner's "for the rest of this turn" on a child-agent card: the parent's run it was given in, so it lapses with that
// turn, and the providers it covers. Held by the parent under its own id.
const TURN_GRANTS: Holding<{ readonly run: string; readonly providers: readonly string[] }> = { name: "child move grants" };

// Where a conversation's children, seats and supervisor are held: each conversation's actor.
type Actors = Pick<ConversationActors, "holdings">;

/** Records that this conversation's shell may supervise children; `supervisor` is the exact object a tool call uses. */
export const armSupervisor = (actors: Actors, conversationId: string, supervisor: ChildSupervisor): void => {
    actors.holdings(SUPERVISORS).hold(conversationId, conversationId, supervisor);
};

/** The armed supervisor for a conversation, or undefined if none was armed. */
export const supervisorFor = (actors: Actors, conversationId: string): ChildSupervisor | undefined =>
    actors.holdings(SUPERVISORS).get(conversationId);

// Whether this conversation is a spawned child, per its parent's record (the `sub-` prefix is cosmetic, not
// authoritative). Used to stop anything starting a turn on a child whose report already reached its parent.
export const isSpawnedChild = (actors: Actors, conversationId: string): boolean => actors.holdings(CHILDREN).has(conversationId);

// How deep a conversation sits under the spawns above it; 0 for one nobody spawned.
export const spawnDepthOf = (actors: Actors, conversationId: string): number => actors.holdings(CHILDREN).get(conversationId)?.depth ?? 0;

// Every child this daemon knows of, for invariant.ts to cross-check against live turns. Settled children stay listed
// since a follow-up `send` resumes them.
export const childLedger = (
    actors: Actors,
): readonly {
    readonly conversationId: string;
    readonly parent: string;
    readonly running: boolean;
    readonly startedAt: number;
}[] =>
    actors
        .holdings(CHILDREN)
        .entries()
        .map(([conversationId, kid]) => ({ conversationId, parent: kid.parent, running: kid.running, startedAt: kid.startedAt }));

// Clears the child, seat and supervisor holdings for a fresh test.
export const resetChildrenForTest = (actors: Actors): void => {
    actors.holdings(CHILDREN).clear();
    actors.holdings(SEATS).clear();
    actors.holdings(SUPERVISORS).clear();
    actors.holdings(TURN_GRANTS).clear();
};

// Display label for the roster row; a provider absent from PROVIDERS shows as its raw id.
const labelOf = (provider: AgentProvider): string => PROVIDERS.find((entry) => entry.value === provider)?.label ?? provider;

// What the child is parked on. `wait` gets only the summary; pendingQuestionOf exposes the full card so a parent can
// answer, not just report.
const pendingOf = (event: AgentEvent): { readonly card: PendingChildCard; readonly summary: string } | undefined => {
    if (event.kind === "question") {
        return {
            card: { kind: "question", requestId: event.requestId, questions: event.questions },
            summary: event.questions[0]?.question ?? "Waiting on a question.",
        };
    }
    if (event.kind === "permission") {
        return {
            card: { kind: "permission", requestId: event.requestId },
            summary: event.title ?? `Waiting on permission for ${event.toolName}.`,
        };
    }
    if (event.kind === "plan") {
        return { card: { kind: "plan", requestId: event.requestId }, summary: "Waiting for its plan to be approved." };
    }
    return undefined;
};

/**
 * Full question a blocked child is parked on. Undefined if it is parked on a consent hold (the owner's, never the
 * parent's) or not parked at all.
 */
export const pendingQuestionOf = (actors: Actors, childId: string): PendingChildCard | undefined => {
    const pending = actors.holdings(CHILDREN).get(childId)?.pending;
    return pending?.kind === "question" ? pending : undefined;
};

/** Why a child's runtime was killed under it, as the ending its parent reads; undefined for a failure of its own. */
export const childKillNote = async (
    services: Pick<Services, "conversations" | "resources">,
    childId: string,
    failure: string,
): Promise<string | undefined> => {
    if (!runtimeKilled(failure)) {
        return undefined;
    }
    const before = services.conversations.holdings(CHILDREN).get(childId)?.oomKillsAtStart;
    // Read now, not reused: the count has to be the one after the death.
    const shortRecently = await services.resources.shortRecently();
    const snapshot = await services.resources.snapshot();
    return killNote(killCauseOf({ oomKills: snapshot.reading.oomKills, shortRecently }, before), failure);
};

// What the roster row says while a follow-up waits behind a turn somebody else started on the child.
const BEHIND_SUMMARY = "Waiting for the turn already running on it to end; your message runs right after.";
// How many times a follow-up waits out another turn before it gives up: a turn that ends can be followed at once by
// what waited in the conversation's own queue.
const BEHIND_TRIES = 3;
// How long one wait behind another turn may last; past it the parent is told its words were not delivered.
const BEHIND_MAX_MS = 2 * 60 * 60_000;

// Why a child's turn never started, as the ending its parent reads.
const NOT_STARTED = {
    stuck: `The turn already running on it did not end within ${BEHIND_MAX_MS / 3_600_000} hours, so your message was not delivered: send it again once it is free.`,
    busy: "Other turns kept its conversation busy, so your message was not delivered: send it again once it is free.",
    archived: "That child is archived: only a person's message reopens it.",
} as const satisfies Record<string, string>;

type StartedChildTurn = Exclude<ReturnType<Services["turns"]["run"]>, string>;

// Waits out the turn holding the child's conversation, once: whether it ended in time.
const outlast = async (services: Services, childId: string, kid: ChildRecord | undefined): Promise<boolean> => {
    const other = liveRunOf(services.conversations, childId);
    if (kid !== undefined) {
        kid.behind = true;
    }
    noteSpawnedChild(services.conversations, childId, { status: "pending", summary: BEHIND_SUMMARY });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ended = await Promise.race([
        (other?.waitUntilFinished() ?? Promise.resolve()).then(() => true),
        new Promise<false>((resolve) => {
            timer = setTimeout(() => resolve(false), BEHIND_MAX_MS);
            timer.unref();
        }),
    ]);
    clearTimeout(timer);
    if (kid !== undefined) {
        kid.behind = false;
    }
    return ended;
};

// Another turn can hold the child's conversation when this one's comes: a person writing in its own chat, the land
// conflict the owner sent it, a red land check routed back to it, a turn resumed after an allowance refused it. The
// parent's words wait for that turn to end rather than being dropped.
const startWhenFree = async (
    services: Services,
    childId: string,
    kid: ChildRecord | undefined,
    turn: TurnInput & { conversationId: string },
): Promise<{ readonly started: StartedChildTurn } | { readonly refused: keyof typeof NOT_STARTED }> => {
    let run = services.turns.run(turn);
    let tries = 0;
    for (; run === "busy" && tries < BEHIND_TRIES; tries += 1) {
        if (!(await outlast(services, childId, kid))) {
            return { refused: "stuck" };
        }
        run = services.turns.run(turn);
    }
    if (run === "busy" || run === "archived") {
        return { refused: run };
    }
    if (tries > 0) {
        noteSpawnedChild(services.conversations, childId, { status: "running", summary: "" });
    }
    return { started: run };
};

// What a child's turn has shown so far, as its frames are followed; the report is its last closed bubble.
interface ChildTurnTally {
    bubble: string;
    report: string;
    toolUses: number;
    tokens: number;
    failure: string | undefined;
    // A re-run of this same turn the sandbox booked for itself, as its failure frame states it.
    rerun: { readonly at?: number | undefined } | undefined;
}

const freshTally = (): ChildTurnTally => ({ bubble: "", report: "", toolUses: 0, tokens: 0, failure: undefined, rerun: undefined });

// The child's own prose, top level only: a sub-delegation's words are not its report.
const takeProse = (tally: ChildTurnTally, event: Extract<AgentEvent, { kind: "delta" | "text_end" }>): void => {
    if (event.parentToolUseId !== undefined) {
        return;
    }
    if (event.kind === "delta") {
        tally.bubble += event.text;
        return;
    }
    // The last closed bubble is the report; earlier text is only a greeting.
    tally.report = tally.bubble.trim() === "" ? tally.report : tally.bubble;
    tally.bubble = "";
};

// A card the child parked on: blocked, saying on what, with the whole card kept for `answer`.
const takeParked = (services: Services, childId: string, kid: ChildRecord | undefined, event: AgentEvent): void => {
    const parked = pendingOf(event);
    if (parked === undefined) {
        return;
    }
    if (kid !== undefined) {
        kid.pending = parked.card;
    }
    noteSpawnedChild(services.conversations, childId, { status: "blocked", summary: parked.summary });
};

// One frame of a child's turn onto its roster row and its tally. Normalized frames make this work across providers, and
// a child's own sub-delegations still count as its proof.
const takeChildFrame = (services: Services, childId: string, kid: ChildRecord | undefined, tally: ChildTurnTally, event: AgentEvent): void => {
    noteChildWork(services.conversations, event, childId);
    switch (event.kind) {
        case "session":
            if (kid !== undefined) {
                kid.sessionId = event.sessionId;
            }
            return;
        case "delta":
        case "text_end":
            takeProse(tally, event);
            return;
        case "tool_call":
            if (event.parentToolUseId === undefined) {
                tally.toolUses += 1;
                noteSpawnedChild(services.conversations, childId, { toolUses: tally.toolUses, lastTool: event.name });
            }
            return;
        case "usage":
            tally.tokens += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
            noteSpawnedChild(services.conversations, childId, { tokens: tally.tokens });
            return;
        case "resolved":
            if (kid !== undefined) {
                kid.pending = undefined;
            }
            noteSpawnedChild(services.conversations, childId, { status: "running" });
            return;
        case "error":
            tally.failure = event.message;
            tally.rerun = event.autoResume === "scheduled" ? { at: event.nextAt } : undefined;
            return;
        default:
            takeParked(services, childId, kid, event);
    }
};

// A live seat given back as a child's turn ends; the lifetime count keeps it.
const freeSeat = (services: Services, parent: string): void => {
    const seats = services.conversations.holdings(SEATS);
    const now = seats.get(parent);
    if (now !== undefined) {
        seats.hold(parent, parent, { live: Math.max(0, now.live - 1), total: now.total });
    }
};

// Settles a child's turn from its tally: its closing text as the report, a kill named from outside, a re-run the sandbox
// booked said with the failure, and its seat freed.
const settleChildTurn = async (services: Services, childId: string, parent: string, kid: ChildRecord | undefined, tally: ChildTurnTally): Promise<void> => {
    const closing = (tally.bubble.trim() !== "" ? tally.bubble : tally.report).trim().slice(0, REPORT_KEPT);
    // Read while the record still says running, so a `send` cannot start a follow-up this settle then overwrites.
    const killed = tally.failure === undefined ? undefined : await childKillNote(services, childId, tally.failure);
    const rerun = tally.failure === undefined || tally.rerun === undefined ? undefined : bookedRerunWords(tally.rerun);
    const error = killed ?? (rerun === undefined ? tally.failure : `${tally.failure} ${rerun}`);
    if (kid !== undefined) {
        kid.running = false;
        kid.queued = false;
        kid.pending = undefined;
    }
    settleSpawnedChild(services.conversations, childId, {
        status: killed !== undefined ? "killed" : tally.failure !== undefined ? "failed" : "completed",
        report: closing,
        ...opt("error", error),
    });
    freeSeat(services, parent);
};

// Follows a run of the child's to its end onto its roster row, whoever started it; one that never started settles as the
// tally says.
const followChildRun = async (
    services: Services,
    childId: string,
    parent: string,
    kid: ChildRecord | undefined,
    run: { readonly frames: () => AsyncGenerator<AgentEvent> } | undefined,
    tally: ChildTurnTally,
): Promise<void> => {
    try {
        if (run !== undefined) {
            for await (const event of run.frames()) {
                takeChildFrame(services, childId, kid, tally, event);
            }
        }
    } catch (error) {
        tally.failure = errorMessage(error);
    } finally {
        await settleChildTurn(services, childId, parent, kid, tally);
    }
};

// Admits one child turn to the box and starts it once its conversation is free, or says in the tally why it did not.
const admitAndStart = async (
    services: Services,
    childId: string,
    kid: ChildRecord | undefined,
    turn: TurnInput & { conversationId: string },
    where: WorkPlace,
    tally: ChildTurnTally,
): Promise<StartedChildTurn | undefined> => {
    if (kid !== undefined) {
        kid.queued = true;
    }
    // Admitted here, where the wait can be shown on the child's row, and kept for the door, which takes this admission
    // instead of judging the same turn a second time. A child placed on a runner holds nothing here.
    const room = await services.resources.admit({
        workload: "agentRuntime",
        attended: false,
        owner: childId,
        where,
        forTurn: true,
        wait: {
            onShort: (diagnosis) => noteSpawnedChild(services.conversations, childId, { status: "pending", summary: `Waiting for memory: ${diagnosis}.` }),
        },
    });
    if (room.verdict !== "run") {
        tally.failure = room.message;
        return undefined;
    }
    if (room.waitedMs > 0) {
        noteSpawnedChild(services.conversations, childId, { status: "running", summary: "" });
    }
    if (kid !== undefined) {
        kid.queued = false;
        kid.oomKillsAtStart = (await services.resources.snapshot(0)).reading.oomKills;
    }
    // The parent's agent asked for it, never a person.
    const start = await startWhenFree(services, childId, kid, turn);
    if ("refused" in start) {
        tally.failure = NOT_STARTED[start.refused];
        return undefined;
    }
    return start.started;
};

// Pumps one child turn onto the roster once the box has room for it; shared by spawn and follow-up send. Detached: the
// caller returns with the child queued, and every ending, a refusal included, settles the record and frees its seat.
const runChildTurn = (services: Services, childId: string, parent: string, turn: TurnInput & { conversationId: string }, where: WorkPlace): void => {
    void (async () => {
        const kid = services.conversations.holdings(CHILDREN).get(childId);
        const tally = freshTally();
        let run: StartedChildTurn | undefined;
        try {
            run = await admitAndStart(services, childId, kid, turn, where, tally);
        } catch (error) {
            tally.failure = errorMessage(error);
        }
        await followChildRun(services, childId, parent, kid, run, tally);
    })();
};

// The roster handle a child's records are filed through: under its parent, in the parent's tree.
const rosterHandle = (services: Services, parent: string, cwd: string): SubagentTurn => ({
    conversationId: parent,
    conversations: services.conversations,
    cwd,
    sessionId: undefined,
    subagentsDir: undefined,
});

// A child's roster row as it opens: named by its task, wearing its provider's label and its model. Every turn of the
// child reopens it the same way, so a follow-up never retitles it with its own words.
const childBirth = (id: string, spec: ChildSpawnSpec, depth: number): SpawnedChildBirth => {
    const { provider, harness, model } = childRouting(spec);
    return { id, description: taskLine(spec), agentType: labelOf(provider), provider, harness, spawnDepth: depth, model };
};

// Why the sandbox sent a child's turn again by itself, in its parent's words.
const RERUN_WHY = {
    auth: "its Claude sign-in was renewed",
    outage: "its model provider came back",
    restart: "the sandbox restarted in the middle of its turn",
    stopped: "its last turn stopped short",
    limit: "its allowance reopened",
    switched: "its allowance ran out and it moved to another account",
    carried: "its allowance ran out and it moved to another account",
    refused: "its allowance refused the last attempt before anything ran",
    door: "its last attempt was turned away before anything ran",
    overflow: "its session outgrew the model's window",
    answered: "the sandbox restarted while it waited on an answer",
} as const satisfies Record<ResumeReason, string>;

// What started a turn on a child without its parent, in words for the parent; undefined where other news already says
// it (a red land check routed back to it).
const startedWhy = (started: DomainEventMap["run.started"]): string | undefined => {
    if (started.errand === "land-breakage" || started.errand === "land-held") {
        return undefined;
    }
    if (started.resume !== undefined) {
        return `the sandbox sent its turn again by itself because ${RERUN_WHY[started.resume]}`;
    }
    const speaker = started.speaker;
    if (speaker?.kind === "agent") {
        return `another conversation, \`${speaker.conversationId}\`, sent it a message`;
    }
    return speaker?.kind === "sandbox" && speaker.source !== undefined ? `the sandbox started a turn on it (${speaker.source})` : "the sandbox started a turn on it";
};

/**
 * A turn that starts on a spawned child without its parent (a re-run the sandbox fired itself once an allowance reopened
 * or a turn stopped short, a watch it left, another conversation's message, a red check sent back to it) is still the
 * parent's to supervise: the child's row reopens and counts as live, its ending reaches the parent like any other, and a
 * parent with a live turn hears that it is working, so it neither sends the task again nor hands it to another agent. A
 * person's own turn in the child's chat stays theirs, and a turn the parent started is already followed.
 */
export const adoptChildTurn = (services: Services, started: DomainEventMap["run.started"]): void => {
    const childId = started.conversationId;
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    const run = liveRunOf(services.conversations, childId);
    if (kid === undefined || kid.running || run === undefined || started.speaker?.kind === "person") {
        return;
    }
    kid.running = true;
    kid.startedAt = Date.now();
    const seats = services.conversations.holdings(SEATS);
    const ledger = seats.get(kid.parent) ?? { live: 0, total: 0 };
    seats.hold(kid.parent, kid.parent, { live: ledger.live + 1, total: ledger.total });
    openSpawnedChild(rosterHandle(services, kid.parent, kid.cwd), childBirth(childId, kid.spec, kid.depth));
    void followChildRun(services, childId, kid.parent, kid, run, freshTally());
    const why = startedWhy(started);
    if (why !== undefined) {
        void sayToParent(
            services,
            kid.parent,
            `Your child agent \`${childId}\` ("${taskLine(kid.spec)}") is working: ${why}. Its report reaches you when it ends, like any turn of its: do not send it the task again or give the task to another agent meanwhile.`,
        );
    }
};

// A supervisor move let through; `run` is set only when the owner re-pointed a start on the card, and is then the whole
// run to start the child on in place of the agent's.
type Admission = { readonly ok: true; readonly run?: ChildRun } | { readonly ok: false; readonly message: string };

// What the owner's rules and the taint floor say of a move before anybody is asked.
type MoveVerdict = { readonly effect: "allow" } | { readonly effect: "deny"; readonly message: string } | { readonly effect: "hold"; readonly reason: string };

// Whether the owner already allowed held moves on this provider for the rest of the parent's live turn.
const turnAllows = (actors: Actors, parent: string, provider: string): boolean => {
    const grant = actors.holdings(TURN_GRANTS).get(parent);
    return grant !== undefined && grant.run === liveRunOf(actors, parent)?.id && grant.providers.includes(provider);
};

// The owner's "for the rest of this turn": this provider joins what the parent's run may do without asking again.
const grantTurn = (actors: Actors, parent: string, run: string, provider: string): void => {
    const grant = actors.holdings(TURN_GRANTS).get(parent);
    const providers = grant?.run === run ? grant.providers : [];
    actors.holdings(TURN_GRANTS).hold(parent, parent, { run, providers: [...new Set([...providers, provider])] });
};

// Consulted before every supervisor mutation (spawn, send, answer): the owner's action rules plus the taint floor. A hold
// the owner already allowed for the rest of this turn lets the move through.
const judgeMove = async (services: Services, parent: string, provider: string): Promise<MoveVerdict> => {
    const settings = await services.sandboxSettings.get();
    const verdict = guard(childSpawn, { provider, rules: settings.actionRules, ...opt("outsideSource", conversationTaintSource(parent)) });
    if (verdict.effect === "deny") {
        return { effect: "deny", message: `Refused: ${verdict.reason}.` };
    }
    return verdict.effect === "hold" && !turnAllows(services.conversations, parent, provider) ? { effect: "hold", reason: verdict.reason } : { effect: "allow" };
};

// A provider the owner's rules refuse stays refused when it was picked on the card: the card overrides the agent's
// choice, never the rulebook. A hold is already answered, since the owner is the one who picked it.
const refusedByRules = async (services: Services, provider: string): Promise<string | undefined> => {
    const settings = await services.sandboxSettings.get();
    const verdict = guard(childSpawn, { provider, rules: settings.actionRules });
    return verdict.effect === "deny" ? `Refused: ${verdict.reason}.` : undefined;
};

// Which supervisor move is held, so the card names the action truthfully rather than a generic one.
const MOVE_TITLE: Readonly<Record<ChildMove, string>> = {
    spawn: "Start a child agent",
    send: "Send this to a child agent",
    answer: "Answer a child agent",
};
const MOVE_BUTTON: Readonly<Record<ChildMove, string>> = { spawn: "Start it", send: "Send it", answer: "Answer it" };

// A card lives as long as the parent's turn, which an orchestration can keep open for hours, since nothing waits on it
// any more; past this a question nobody answers stops holding a move.
const SUPERVISION_DEADLINE_MS = 6 * 60 * 60_000;

// The card's second allow: this move, and every held one on the same provider for the rest of the parent's turn.
const ALWAYS_LABEL = "Allow for the rest of this turn";

// What the card quotes of the parent's words to a child: enough to judge it by, not a second transcript.
const MESSAGE_SHOWN = 600;

// Why a hold refuses with nowhere to ask: a detached `agents` shell, or a turn that already ended.
const nowhereToAsk = (reason: string): string =>
    `Held for the owner: ${reason}. This call arrived outside a live turn, so there was nowhere to ask them. Ask in chat; they can also set the agents.spawn action rule.`;

// Raises the card on the parent's live turn and settles with the owner's answer, however long that takes; nobody's call
// waits on it. The two refusals differ because the model's next move differs, and only one is the owner declining.
const askOwner = async (services: Services, parent: string, run: LiveRun, ask: ChildAgentAsk, reason: string): Promise<Admission> => {
    const { move, provider } = ask;
    const ended = new AbortController();
    void run.waitUntilFinished().then(() => ended.abort());
    const { decision, reply } = await raiseRequest(
        cardDeps(services),
        { conversationId: parent, push: (event) => run.push(event) },
        {
            kind: "permission",
            onAbort: { kind: "permission", requestId: "", decision: "deny", feedback: "The turn ended before you answered." },
            raised: (requestId) => ({
                kind: "permission",
                requestId,
                toolName: "agents.spawn",
                title: `${MOVE_TITLE[move]} on ${labelOf(provider)}?`,
                displayName: MOVE_BUTTON[move],
                reason,
                alwaysLabel: ALWAYS_LABEL,
                child: ask,
            }),
            approves: (answer) => answer.decision !== "deny",
            signal: ended.signal,
            deadlineMs: SUPERVISION_DEADLINE_MS,
        },
    );
    switch (decision) {
        case "approved": {
            if (reply.decision === "always") {
                grantTurn(services.conversations, parent, run.id, provider);
            }
            // Only a start can be re-pointed: a child already running keeps the run it was started on (childProfile).
            const picked = move === "spawn" ? reply.child : undefined;
            return picked !== undefined && !sameChildRun(ask, picked) ? { ok: true, run: childRunOf(picked) } : { ok: true };
        }
        case "unanswered":
            return {
                ok: false,
                message: `Nobody answered the request to ${move === "spawn" ? "start" : move} a child agent, so it did not run. Carry on without it and say what you left undone.`,
            };
        case "declined":
            return {
                ok: false,
                message: `The owner declined this. Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
            };
    }
};

// A child on a runtime with rulebook "none" has no gating of its own, so the parent's turn taints, the same as reading
// a fetched page.
const composeRuntimeFloor = (parent: string, provider: AgentProvider, harness: AgentHarness): void => {
    if (capabilitiesOf(provider, harness).rulebook === "none") {
        markConversationTaint(parent, `agent:${provider}`);
    }
};

// Reads and reserves the live/lifetime budget in one synchronous step so two concurrent spawns cannot both pass the
// same check. `release` refunds only a reservation whose turn never started.
const admitChildTurn = async (
    services: Services,
    parent: string,
): Promise<{ readonly ok: true; readonly release: () => void } | { readonly ok: false; readonly message: string }> => {
    const settings = await services.sandboxSettings.get();
    const seats = services.conversations.holdings(SEATS);
    const ledger = seats.get(parent) ?? { live: 0, total: 0 };
    if (ledger.live >= settings.subagentsAtOnce) {
        return { ok: false, message: `${ledger.live} children are already running: wait for one before starting another.` };
    }
    if (ledger.total >= settings.subagentsPerTurn) {
        return { ok: false, message: `This conversation has started ${ledger.total} child turns, its lifetime budget.` };
    }
    seats.hold(parent, parent, { live: ledger.live + 1, total: ledger.total + 1 });
    return {
        ok: true,
        release: (): void => {
            const now = seats.get(parent);
            if (now !== undefined) {
                seats.hold(parent, parent, { live: Math.max(0, now.live - 1), total: Math.max(0, now.total - 1) });
            }
        },
    };
};

// `provider` and `model` are required, with no fallback default. `harness` still defaults to "native" (the provider's
// own loop), which spends no extra allowance and needs no account.
const childRouting = (spec: ChildSpawnSpec): { readonly provider: AgentProvider; readonly harness: AgentHarness; readonly model: string } => ({
    provider: spec.provider,
    harness: spec.harness ?? DEFAULT_HARNESS,
    model: spec.model,
});

// Every child turn's profile: its own worktree, so parallel children and the parent never edit the same files, and
// nobody at a composer, which also floors the persona so it speaks for no outside account. No `runRole`: the parent's
// own provider and model pick decides, not a settings-row default.
const childProfile = (spec: ChildSpawnSpec): TurnProfile => {
    const { provider, harness, model } = childRouting(spec);
    const profile: TurnProfile = { agent: provider, harness, model, isolated: true, unattended: true };
    // Each knob only where one was named: an absent one is the model's own default.
    if (spec.effort !== undefined) {
        profile.effort = spec.effort;
    }
    if (spec.thinking !== undefined) {
        profile.thinking = spec.thinking;
    }
    if (spec.fast !== undefined) {
        profile.fast = spec.fast;
    }
    if (spec.account !== undefined) {
        profile.account = spec.account;
    }
    return profile;
};

// A spec while it is being put together, before it is handed on as the readonly one.
type SpecDraft = { -readonly [K in keyof ChildSpawnSpec]: ChildSpawnSpec[K] };

// The spec the owner allowed, when they re-pointed the child on the card: their run replaces the agent's whole, so an
// effort or an account the agent named for its own model never rides along onto another.
const withRun = (spec: ChildSpawnSpec, run: ChildRun): ChildSpawnSpec => {
    const { harness: _harness, account: _account, effort: _effort, thinking: _thinking, fast: _fast, ...task } = spec;
    const next: SpecDraft = { ...task, provider: run.provider, model: run.model };
    if (run.harness !== undefined) {
        next.harness = run.harness;
    }
    if (run.account !== undefined) {
        next.account = run.account;
    }
    if (run.effort !== undefined) {
        next.effort = run.effort;
    }
    if (run.thinking !== undefined) {
        next.thinking = run.thinking;
    }
    if (run.fast !== undefined) {
        next.fast = run.fast;
    }
    return next;
};

// A run in words for the parent's tool result: provider and model as the ids the agent spawns with, since that is its
// vocabulary, and each knob only when one was named.
const runWords = (run: ChildRun): string =>
    [
        `${run.provider}/${run.model}`,
        run.effort !== undefined ? `${run.effort} effort` : undefined,
        run.thinking === false ? "no extended thinking" : undefined,
        run.fast === true ? "fast speed" : undefined,
        run.harness === "claude-code" ? "the Claude Code loop" : undefined,
        run.account !== undefined ? `account ${run.account}` : undefined,
    ]
        .filter((part) => part !== undefined)
        .join(", ");

/** What the parent is told when the owner started its child on something else, so its own report names the right model. */
export const repointedNote = (asked: ChildRun, run: ChildRun): string =>
    `The owner changed what it runs on before allowing it: it runs on ${runWords(run)}, not on ${runWords(asked)} as you asked.`;

// A child's task in one line, as its roster row and the gate's card both show it.
const taskLine = (spec: Pick<ChildSpawnSpec, "prompt" | "description">): string =>
    (spec.description ?? spec.prompt).replaceAll(/\s+/gu, " ").trim().slice(0, 200);

// What the gate's card says about a child: its run, task and machine off the call's spec or the child's own record,
// never the parent's prose about them.
const childAsk = (move: ChildMove, spec: ChildSpawnSpec): ChildAgentAsk => {
    const ask: ChildAgentAsk = { move, ...childRunOf(spec), task: taskLine(spec) };
    if (spec.on !== undefined) {
        ask.on = spec.on;
    }
    return ask;
};

// The same for a child that already exists, with the words the parent would say to it.
const askAbout = (kid: ChildRecord, move: ChildMove, childId: string, message: string): ChildAgentAsk => ({
    ...childAsk(move, kid.spec),
    child: childId,
    message: message.trim().slice(0, MESSAGE_SHOWN),
});

// The runner a child goes to, undefined for here. No preference: the scheduler places it. A named machine gets it, or
// here if that machine is unusable.
const childPlacement = async (
    services: Services,
    spec: ChildSpawnSpec,
    provider: AgentProvider,
    harness: AgentHarness,
): Promise<string | undefined> =>
    spec.on === "here"
        ? undefined
        : placeFanOut(
              await runnerSummaries(services),
              { inFlight: services.conversations.inFlightByRunner() },
              {
                  ...(spec.on !== undefined ? { asked: spec.on } : {}),
                  // A credential that cannot travel keeps the child here unless a machine is named explicitly.
                  travels: credentialsTravel(provider, harness),
              },
          ).runner;

// What a parent is told of a move held for the owner. Nothing holds its call open while they decide: it carries on, and
// hears what becomes of the move.
const HELD_START =
    "Held for the owner's approval: a card in your chat asks them, and you carry on meanwhile. It starts once they allow it; wait on it like any child. If they decline, or nobody answers before your turn ends, it ends as failed without having run.";
const HELD_MESSAGE =
    "Held for the owner's approval: a card in your chat asks them, and you carry on meanwhile. It goes to the child once they allow it, and you are told if it does not.";
const HELD_ANSWER =
    "Held for the owner's approval: a card in your chat asks them, and you carry on meanwhile. Your answer goes once they allow it, and you are told if it does not.";
// What a held start's roster row says while the owner decides.
const START_SUMMARY = "Waiting for the owner to allow its start, on the card in your chat.";

// A child's record, as it is filed before its first turn: resolved routing rather than the raw spec, so a follow-up
// reaches the same provider and model without drift.
const childRecordOf = (parent: ChildParent, spec: ChildSpawnSpec, depth: number, held?: ChildRecord["held"]): ChildRecord => {
    const { provider, harness, model } = childRouting(spec);
    return {
        parent: parent.conversationId,
        spec: { ...spec, provider, harness, model },
        profile: childProfile(spec),
        depth,
        cwd: parent.cwd,
        sessionId: undefined,
        running: true,
        startedAt: Date.now(),
        pending: undefined,
        queued: false,
        behind: false,
        held,
        oomKillsAtStart: undefined,
    };
};

// A start the gate let through, or held until the owner answers: what was asked, how deep it goes, and the id it runs as.
interface ChildStart {
    readonly asked: ChildSpawnSpec;
    readonly depth: number;
    readonly id: string;
}

// Starts a child the gate let through: on the owner's pick when they re-pointed it (`repointed`), else as asked.
const startChild = async (
    services: Services,
    parent: ChildParent,
    start: ChildStart & { readonly spec: ChildSpawnSpec; readonly repointed?: ChildRun },
): Promise<ChildSpawnResult> => {
    const { asked, spec, depth, id, repointed } = start;
    if (spec.provider !== asked.provider) {
        const refused = await refusedByRules(services, spec.provider);
        if (refused !== undefined) {
            return { ok: false, message: refused };
        }
    }
    const { provider, harness } = childRouting(spec);
    const admitted = await admitChildTurn(services, parent.conversationId);
    if (!admitted.ok) {
        return admitted;
    }
    // Seat is claimed here; every exit must hand it to a running turn or refund it, or the cap drops permanently.
    let handedOff = false;
    try {
        composeRuntimeFloor(parent.conversationId, provider, harness);
        const placement = await childPlacement(services, spec, provider, harness);
        const record = childRecordOf(parent, spec, depth);
        const turn: TurnInput & { conversationId: string } = {
            prompt: spec.prompt,
            conversationId: id,
            title: taskLine(spec).slice(0, 80),
            // Its starter is the parent, which is also how it inherits the parent's owner (agents-registry.ts).
            ...spokenBy({ kind: "agent", conversationId: parent.conversationId }),
            ...opt("placement", placement === undefined ? undefined : { kind: "runner" as const, id: placement }),
            ...record.profile,
        };
        services.conversations.holdings(CHILDREN).hold(parent.conversationId, id, record, id);
        // Files under the parent's conversation, what `wait` matches; a held start's waiting row gives way to this one.
        openSpawnedChild(rosterHandle(services, parent.conversationId, parent.cwd), childBirth(id, spec, depth), true);
        runChildTurn(services, id, parent.conversationId, turn, placement === undefined ? "local" : { runner: placement });
        handedOff = true;
        return repointed === undefined ? { ok: true, id } : { ok: true, id, note: repointedNote(childRunOf(asked), repointed) };
    } finally {
        if (!handedOff) {
            admitted.release();
        }
    }
};

// A start waiting on the owner, filed as a child already, so `wait` parks on it and `send` refuses it with the reason.
const holdChildStart = (services: Services, parent: ChildParent, start: ChildStart): void => {
    services.conversations.holdings(CHILDREN).hold(parent.conversationId, start.id, childRecordOf(parent, start.asked, start.depth, "start"), start.id);
    openSpawnedChild(rosterHandle(services, parent.conversationId, parent.cwd), childBirth(start.id, start.asked, start.depth));
    noteSpawnedChild(services.conversations, start.id, { status: "pending", summary: START_SUMMARY });
};

// A held start that will not run: its waiting row ends failed with why, and a parent in its turn is told, unless its wait
// already took the ending.
const abandonChildStart = async (services: Services, parent: string, id: string, message: string): Promise<void> => {
    services.conversations.holdings(CHILDREN).drop(id);
    settleSpawnedChild(services.conversations, id, { status: "failed", report: "", error: message });
    if (subagentEndingReported(services.conversations, id)) {
        return;
    }
    if (await sayToParent(services, parent, `Your child agent \`${id}\` did not start: ${message}`)) {
        markSubagentEndingReported(services.conversations, id);
    }
};

// What becomes of a held start once the owner answers: it starts on what they allowed, or ends failed. A parent still in
// its turn hears what its wait cannot show it, a re-point.
const startAllowed = async (services: Services, parent: ChildParent, start: ChildStart, admission: Admission): Promise<void> => {
    try {
        const started = admission.ok
            ? await startChild(services, parent, {
                  ...start,
                  spec: admission.run === undefined ? start.asked : withRun(start.asked, admission.run),
                  ...opt("repointed", admission.run),
              })
            : admission;
        if (!started.ok) {
            await abandonChildStart(services, parent.conversationId, start.id, started.message);
            return;
        }
        if (started.note !== undefined) {
            void sayToParent(services, parent.conversationId, `The owner allowed your child agent \`${start.id}\` to start. ${started.note}`);
        }
    } catch (error) {
        await abandonChildStart(services, parent.conversationId, start.id, errorMessage(error));
    }
};

/**
 * Starts a child agent and returns once it is queued; on a box short of memory it waits as `pending` before its turn
 * runs. Budget/depth refusals come back immediately; a provider refusal surfaces later as the child's own failure. A
 * start the owner must allow comes back at once as well, `held`, its row waiting until they answer.
 */
export const spawnChild = async (services: Services, parent: ChildParent, asked: ChildSpawnSpec): Promise<ChildSpawnResult> => {
    const settings = await services.sandboxSettings.get();
    const depth = spawnDepthOf(services.conversations, parent.conversationId) + 1;
    if (depth > settings.subagentDepth) {
        return { ok: false, message: `Spawn depth ${settings.subagentDepth} reached: this agent is itself a spawned child and may not go deeper.` };
    }
    const verdict = await judgeMove(services, parent.conversationId, asked.provider);
    if (verdict.effect === "deny") {
        return { ok: false, message: verdict.message };
    }
    const start: ChildStart = { asked, depth, id: `sub-${newConversationId()}` };
    if (verdict.effect === "allow") {
        return startChild(services, parent, { ...start, spec: asked });
    }
    const run = liveRunOf(services.conversations, parent.conversationId);
    if (run === undefined) {
        return { ok: false, message: nowhereToAsk(verdict.reason) };
    }
    holdChildStart(services, parent, start);
    void askOwner(services, parent.conversationId, run, childAsk("spawn", asked), verdict.reason).then((admission) =>
        startAllowed(services, parent, start, admission),
    );
    return { ok: true, id: start.id, held: true, note: HELD_START };
};

// Why a message cannot go to the child yet, whatever the owner's rules say; undefined when it can.
const notYet = (kid: ChildRecord): string | undefined => {
    if (kid.held === "start") {
        return "It has not started: the owner has not allowed its start yet. Wait for it, then send again.";
    }
    if (kid.held === "message") {
        return "Your last message to it still waits for the owner's approval: wait for that, then send again.";
    }
    if (kid.queued) {
        return "It is waiting for memory and has not started: wait for it, then send again.";
    }
    return kid.behind ? "Your last message is still waiting for the turn already running on it to end: wait for it, then send again." : undefined;
};

// A follow-up turn on a settled child, resuming its last reported session.
const followUp = async (services: Services, parent: ChildParent, kid: ChildRecord, childId: string, message: string): Promise<ChildActionResult> => {
    const admitted = await admitChildTurn(services, parent.conversationId);
    if (!admitted.ok) {
        return admitted;
    }
    // Seat is claimed; same handoff-or-refund rule as startChild covers a throw before the turn starts.
    let handedOff = false;
    try {
        const turn: TurnInput & { conversationId: string } = {
            prompt: message,
            conversationId: childId,
            // Its parent asked, as for the spawn: the settled turn reports back to that parent (child-report.ts).
            ...spokenBy({ kind: "agent", conversationId: parent.conversationId }),
            ...kid.profile,
            // Session from the last turn's report; absent falls back to the ordinary reopened-conversation seed.
            ...opt("sessionId", kid.sessionId),
        };
        // Reopens the roster record under the same id with fresh state, so `wait` sees it running again.
        openSpawnedChild(rosterHandle(services, parent.conversationId, kid.cwd), childBirth(childId, kid.spec, kid.depth));
        // A turn somebody else started (a person in its chat, a land conflict) is not the parent's to steer: the
        // follow-up waits for it to end instead, which is worth saying now.
        const occupied = liveRunOf(services.conversations, childId) !== undefined;
        kid.running = true;
        kid.startedAt = Date.now();
        // A follow-up runs where the conversation already runs: the registry's runner, else here.
        const runner = worktreeOf(services.agents.entry(childId))?.runner;
        runChildTurn(services, childId, parent.conversationId, turn, runner === undefined ? "local" : { runner });
        handedOff = true;
        return {
            ok: true,
            note: occupied
                ? "Sent, to run next: it is busy with a turn it did not get from you (a person, a land conflict or a red check sent back to it), and your message runs as its own follow-up once that ends. Supervise it with wait."
                : "Sent: the child runs a follow-up turn, once there is memory for it. Supervise it with wait.",
        };
    } finally {
        if (!handedOff) {
            admitted.release();
        }
    }
};

// A message the gate let through: steered into the child's live turn, else a follow-up turn of its own.
const deliverToChild = async (services: Services, parent: ChildParent, kid: ChildRecord, childId: string, message: string): Promise<ChildActionResult> => {
    composeRuntimeFloor(parent.conversationId, kid.spec.provider, childRouting(kid.spec).harness);
    // Asked again: an owner answering later may find the child waiting on something new.
    const waiting = notYet(kid);
    if (waiting !== undefined) {
        return { ok: false, message: waiting };
    }
    if (kid.running) {
        // Mid-turn, the only door is the runtime's own steering seam; a runtime without one cannot take words yet.
        return steerTurn(services.conversations, childId, { text: message, voice: "agent" })
            ? { ok: true, note: "Steered: the message lands between its tool calls." }
            : { ok: false, message: "It is mid-turn on a runtime that takes no mid-turn input: wait for it to finish, then send again." };
    }
    return followUp(services, parent, kid, childId, message);
};

// A held message once the owner answers: sent, or not, and the parent told when it did not go.
const sendAllowed = async (services: Services, parent: ChildParent, kid: ChildRecord, childId: string, message: string, admission: Admission): Promise<void> => {
    kid.held = undefined;
    let sent: ChildActionResult;
    try {
        sent = admission.ok ? await deliverToChild(services, parent, kid, childId, message) : admission;
    } catch (error) {
        sent = { ok: false, message: errorMessage(error) };
    }
    if (!sent.ok) {
        void sayToParent(services, parent.conversationId, `Your message to child agent \`${childId}\` did not go: ${sent.message}`);
    }
};

/**
 * Steers a working child, or sends a settled one a follow-up turn resuming its last reported session. Only the parent
 * that started it may reach it. A message the owner must allow comes back at once, and goes when they do.
 */
export const sendToChild = async (services: Services, parent: ChildParent, childId: string, message: string): Promise<ChildActionResult> => {
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    if (kid === undefined || kid.parent !== parent.conversationId) {
        return { ok: false, message: "No such child of this conversation. `list` shows yours." };
    }
    const verdict = await judgeMove(services, parent.conversationId, kid.spec.provider);
    if (verdict.effect === "deny") {
        return { ok: false, message: verdict.message };
    }
    if (verdict.effect === "allow") {
        return deliverToChild(services, parent, kid, childId, message);
    }
    // No card for words that could not go even if the owner allowed them now.
    const waiting = notYet(kid);
    if (waiting !== undefined) {
        return { ok: false, message: waiting };
    }
    const run = liveRunOf(services.conversations, parent.conversationId);
    if (run === undefined) {
        return { ok: false, message: nowhereToAsk(verdict.reason) };
    }
    kid.held = "message";
    void askOwner(services, parent.conversationId, run, askAbout(kid, "send", childId, message), verdict.reason).then((admission) =>
        sendAllowed(services, parent, kid, childId, message, admission),
    );
    return { ok: true, note: HELD_MESSAGE };
};

// Why the child's parked card cannot take the parent's answer; undefined when it can. A permission hold or plan approval
// is the owner's consent alone: a parent approving those would be a model approving its own actions.
const unanswerableWhy = (pending: PendingChildCard | undefined): string | undefined => {
    if (pending === undefined) {
        return "It is not waiting on anything right now.";
    }
    if (pending.kind === "question") {
        return undefined;
    }
    return pending.kind === "permission"
        ? "It is waiting on a PERMISSION, which is the owner's consent to give, not a parent's. The owner answers it in their chat."
        : "It is waiting on PLAN approval, which is the owner's consent to give, not a parent's. The owner answers it in their chat.";
};

// The parent's picks onto the child's question, asked again: it may have settled while the owner was being asked.
const settleAnswer = (services: Services, kid: ChildRecord, answers: Record<string, string[]>): ChildActionResult => {
    const pending = kid.pending;
    const unanswerable = unanswerableWhy(pending);
    if (unanswerable !== undefined || pending === undefined) {
        return { ok: false, message: unanswerable ?? "It is not waiting on anything right now." };
    }
    // Any answer the parent gives is valid; only whether the question still existed comes back.
    if (services.cards.resolve({ kind: "question", requestId: pending.requestId, answers }) !== "settled") {
        return { ok: false, message: "That question already settled." };
    }
    return { ok: true, note: "Answered: the child carries on with your picks." };
};

/** Settles a child's question with the parent's picks, and only a question; one the owner must allow goes when they do. */
export const answerChild = async (
    services: Services,
    parent: ChildParent,
    childId: string,
    answers: Record<string, string[]>,
): Promise<ChildActionResult> => {
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    if (kid === undefined || kid.parent !== parent.conversationId) {
        return { ok: false, message: "No such child of this conversation. `list` shows yours." };
    }
    const unanswerable = unanswerableWhy(kid.pending);
    if (unanswerable !== undefined) {
        return { ok: false, message: unanswerable };
    }
    const verdict = await judgeMove(services, parent.conversationId, kid.spec.provider);
    if (verdict.effect === "deny") {
        return { ok: false, message: verdict.message };
    }
    if (verdict.effect === "allow") {
        return settleAnswer(services, kid, answers);
    }
    const run = liveRunOf(services.conversations, parent.conversationId);
    if (run === undefined) {
        return { ok: false, message: nowhereToAsk(verdict.reason) };
    }
    // The picks as the card quotes them: each question with what the parent chose for it.
    const picks = Object.entries(answers)
        .map(([question, chosen]) => `${question} → ${chosen.join(", ")}`)
        .join("\n");
    void askOwner(services, parent.conversationId, run, askAbout(kid, "answer", childId, picks), verdict.reason).then((admission) => {
        const answered = admission.ok ? settleAnswer(services, kid, answers) : admission;
        if (!answered.ok) {
            void sayToParent(services, parent.conversationId, `Your answer to child agent \`${childId}\` did not go: ${answered.message}`);
        }
    });
    return { ok: true, note: HELD_ANSWER };
};

// Everything a parent may do about its children, as one object shared by every door (tool mounts, CLI arm).
export interface ChildSupervisor {
    readonly spawn: (spec: ChildSpawnSpec) => Promise<ChildSpawnResult>;
    // Read at call time, never snapshotted: an allowance can empty while a turn runs.
    readonly providers: () => Promise<readonly SpawnableProvider[]>;
    readonly send: (childId: string, message: string) => Promise<ChildActionResult>;
    readonly answer: (childId: string, answers: Record<string, string[]>) => Promise<ChildActionResult>;
    readonly pendingQuestion: (childId: string) => PendingChildCard | undefined;
    // Parks until one of the parent's children or background commands moves, or the named one does.
    readonly wait: (options: SubagentWaitOptions) => Promise<WorkWaitOutcome>;
}

export const childSupervisor = (services: Services, parent: ChildParent): ChildSupervisor => ({
    spawn: (spec) => spawnChild(services, parent, spec),
    providers: () => spawnableProviders(services),
    send: (childId, message) => sendToChild(services, parent, childId, message),
    answer: (childId, answers) => answerChild(services, parent, childId, answers),
    pendingQuestion: (childId) =>
        services.conversations.holdings(CHILDREN).get(childId)?.parent === parent.conversationId
            ? pendingQuestionOf(services.conversations, childId)
            : undefined,
    wait: (options) => waitForWork(services.conversations, parent.conversationId, options),
});
