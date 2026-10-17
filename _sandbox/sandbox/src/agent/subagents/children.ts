import { within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { WorkPlace } from "../../workload/resource-budget.js";
import { conversationProfile, isIsolated, worktreeOf } from "../../conversations/registry/agents-store.js";
import { landByHandLeased } from "../../conversations/land/land-by-hand.js";
import { landTargetOf } from "../../conversations/land/land-target.js";
import type { Caller } from "../../auth/auth.js";
import { parentOfActor } from "../../auth/principal.js";
import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentHarness, AgentProvider, TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import type { AskQuestion, ChildAgentAsk, ChildMove, ChildRun } from "@intentic/sandbox-contract/events/requests";
import type { LimitPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import { capabilitiesOf, PROVIDERS } from "@intentic/sandbox-contract/models/agent-catalog";
import { childRunOf, sameChildRun } from "@intentic/sandbox-contract/events/child-run";
import { newConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { cardDeps } from "../../conversations/actor/card-deps.js";
import { raiseRequest } from "../../guard/card-offers.js";
import { type Holding, type LiveRun, liveRunOf, turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Services } from "../../composition.js";
import { steerTurn } from "../checkpoints/agent-steering.js";
import { childSpawn } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { conversationTaintSource, markConversationTaint, RUNTIME_SOURCE } from "../../guard/turn-taint.js";
import { killCauseOf, killNote, runtimeKilled } from "./child-death.js";
import { noteChildWork } from "./child-verification.js";
import { bestRoomFor, type SpawnableProvider, spawnableProviders } from "./spawn-catalog.js";
import {
    blockedMoveReporter,
    markSubagentEndingReported,
    noteSpawnedChild,
    openSpawnedChild,
    ranInProcess,
    settleSpawnedChild,
    type SpawnedChildBirth,
    subagentEndingReported,
    type SubagentTurn,
    type SubagentWaitOptions,
} from "./subagents.js";
import { bookedRerunWords, childLandingWords, sayToParent } from "../../conversations/land/child-lands.js";
import {
    type ChildStanding,
    descendantsOf,
    type FamilyCancel,
    type FamilyEnd,
    type FamilyLink,
    familyCancels,
    markFamilyEnded,
} from "./family-cancel.js";
import { filePausedChildren } from "./paused-children.js";
import { capForRoom, FAN_OUT, type Lane, siblingNewsWords } from "./fan-out-governor.js";
import { waitForWork, type WorkWaitOutcome } from "./work-wait.js";
import { deliverWake } from "../../seams/wake-delivery.js";
import { spokenBy } from "../../seams/turn-speaker.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import type { DomainEventMap } from "../../seams/domain-events.js";
import { opt } from "../../opt.js";
import { credentialsTravel, placeFanOut } from "../../runners/runner-scheduler.js";
import { freshRunnerSummaries } from "../../runners/runner-peer.js";
import type { DelegateAsk, LinkListing } from "../../links/linked-children.js";
import { childOpening, childProfile, childRouting, movesOn, onceOnly, providerRefusal, rehomedSpec, repointedNote, sameModel, taskLine, withRun } from "./child-spec.js";
import { ALWAYS_LABEL, BEHIND_MAX_MS, CANCELLED, CANCEL_NOTES, LINKED_MERGE, LINKED_REHOME, MOVE_BUTTON, MOVE_TITLE, NOT_STARTED, START_SUMMARY, carryOnWords, heldAnswer, heldMessage, heldStart, laneHeldNote, movedWords, noRerun, nowhereToAsk, questionWords, quoted, startedWhy, unansweredWords } from "./child-words.js";
import { elsewhereFor, namedPaths, spentAsked } from "./child-listing.js";

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
// Chars of it a wait hands over whole: a report is a message, not a transcript, so this bounds only a runaway one.
const REPORT_WHOLE = 60_000;

export interface ChildSpawnSpec {
    readonly prompt: string;
    // Shown on the roster row and as the child's title, which the naming pass keeps; falls back to the prompt's head,
    // which it names, if omitted.
    readonly description?: string;
    // Required with `model`, taken verbatim — except for a model spawn-catalog.ts measures as spent, which is refused
    // before a seat is taken (spentAsked). It gates nothing else: an unmeasured model is asked as named.
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
    // Where it goes by itself, in this order, when its own provider refuses it in a way no wait soon answers: an account
    // refused outright, a model off the plan, a spent allowance with no reset or one far off (FAR_RERUN_MS). It moves in
    // its own worktree onto the next one the records do not call spent, and its parent is told.
    readonly fallbacks?: readonly ChildRehome[];
}

/** Another provider and model for a child's next turn, in the same worktree (sendToChild, a spawn's fallbacks). */
export interface ChildRehome {
    readonly provider: AgentProvider;
    readonly model: string;
    readonly harness?: AgentHarness;
    readonly effort?: string;
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
export interface ChildRecord {
    readonly parent: string;
    // Replaced only by a re-home (rehomeChild), never by a follow-up drifting.
    spec: ChildSpawnSpec;
    // What every turn of this child runs as, resolved once at spawn, so a follow-up never drifts to another model; a
    // re-home moves it whole.
    profile: TurnProfile;
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
    // What of it waits on the owner's answer to a card: its start, or the parent's last message to it; or its start,
    // held by the fan-out governor until a sibling on its provider is answered or a seat on it frees (`lane`).
    held: "start" | "message" | "lane" | undefined;
    // The OOM killer's count as its current turn started, so its ending can tell a kill from its own failure.
    oomKillsAtStart: number | undefined;
    // Its last settled turn's whole closing message: what a wait hands over where the roster row's summary cut it.
    report: string | undefined;
    // Its parent cancelled it: the turn that stops, or the start that is kept from happening, ends as killed.
    cancelled: boolean;
    // Its turn was refused in a way its spawn's fallbacks answer: set the moment the refusal arrives, so the report of the
    // run that ended is not told to the parent as the end (child-report.ts), and cleared once the move is made or fails.
    movingOn: { readonly failure: string } | undefined;
    // Its turn ended on a wall the sandbox re-runs it past by itself: what stopped it, the run that ended so, the look
    // that ends the pause as failed if the re-run never comes, and what strikes the pause off the record a restart reads
    // (paused-children.ts).
    paused:
        | {
              readonly failure: string;
              readonly run: string | undefined;
              readonly look: ReturnType<typeof setInterval>;
              readonly unrecord: () => void;
          }
        | undefined;
}

// A spawned child's record, held by its parent and filed about the child, so either one's dispose takes it.
const CHILDREN: Holding<ChildRecord> = { name: "children" };
// A parent's child turns, live and lifetime, held by the parent under its own id.
const SEATS: Holding<{ readonly live: number; readonly total: number }> = { name: "child seats" };
// The run a person started in a spawned child's own chat, held by the child under its own id. A parent leaving stops the
// sandbox's turns on its children and never a person's (cancelFamily), and nothing on a run says who started it.
const PERSON_RUNS: Holding<string> = { name: "person runs in child chats" };
// The supervisor a turn armed for the `/children` routes, which have no tool mount to gate; held under its own id.
const SUPERVISORS: Holding<ChildSupervisor> = { name: "child supervisors" };
// The owner's "for the rest of this turn" on a child-agent card: the parent's run it was given in, so it lapses with that
// turn, and the providers it covers. Held by the parent under its own id.
const TURN_GRANTS: Holding<{ readonly run: string; readonly providers: readonly string[] }> = { name: "child move grants" };
// Every child-agent card still up, by request id, held by the parent: which run raised it and on which provider, so the
// owner's "for the rest of this turn" on one answers the others it covers.
const HELD_MOVES: Holding<{ readonly requestId: string; readonly run: string; readonly provider: string }> = { name: "held child moves" };

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
    actors.holdings(HELD_MOVES).clear();
    actors.holdings(PERSON_RUNS).clear();
    FAN_OUT.reset();
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

type StartedChildTurn = Exclude<ReturnType<Services["turns"]["run"]>, string>;

// Starts the child's turn at once, so it is followed from its first frame, and journalled, so it survives a container
// recreate the way every turn the daemon starts does: its parent keeps waiting on it across one, and at the next boot it
// resumes and its report still reaches that parent (child-report.ts reads the parent off the registry).
const startChildTurn = (services: Services, turn: TurnInput & { conversationId: string }): ReturnType<Services["turns"]["run"]> =>
    services.turns.run(turn, { journalled: true });

// Waits out the turn holding the child's conversation, once: whether it ended in time.
const outlast = async (services: Services, childId: string, kid: ChildRecord | undefined): Promise<boolean> => {
    const other = liveRunOf(services.conversations, childId);
    if (kid !== undefined) {
        kid.behind = true;
    }
    noteSpawnedChild(services.conversations, childId, { status: "pending", summary: BEHIND_SUMMARY });
    const ended = await within((other?.waitUntilFinished() ?? Promise.resolve()).then(() => true), BEHIND_MAX_MS, false, { unref: true });
    if (kid !== undefined) {
        kid.behind = false;
    }
    return ended;
};

// Another turn can hold the child's conversation when this one's comes: a person writing in its own chat, the land
// conflict the owner sent it, a turn resumed after an allowance refused it. The parent's words wait for that turn to end
// rather than being dropped.
// The room admitted for the turn is held only briefly (resource-budget.ts), so a turn that waited behind another one asks
// for room again before it starts: otherwise the door judges it afresh with its run already held, and the child reads as
// working with nothing running for as long as that second wait lasts.
const startWhenFree = async (
    services: Services,
    childId: string,
    kid: ChildRecord | undefined,
    turn: TurnInput & { conversationId: string },
    readmit: () => Promise<string | undefined>,
): Promise<{ readonly started: StartedChildTurn } | { readonly refused: string }> => {
    let run = startChildTurn(services, turn);
    let tries = 0;
    for (; run === "busy" && tries < BEHIND_TRIES; tries += 1) {
        if (!(await outlast(services, childId, kid))) {
            return { refused: NOT_STARTED.stuck };
        }
        const short = await readmit();
        if (short !== undefined) {
            return { refused: short };
        }
        if (kid?.cancelled === true) {
            return { refused: NOT_STARTED.cancelled };
        }
        run = startChildTurn(services, turn);
    }
    if (run === "busy" || run === "archived") {
        return { refused: NOT_STARTED[run] };
    }
    if (tries > 0) {
        noteSpawnedChild(services.conversations, childId, { status: "running", summary: "" });
    }
    return { started: run };
};

// What a child's turn has shown so far, as its frames are followed; the report is its last closed bubble.
export interface ChildTurnTally {
    bubble: string;
    report: string;
    toolUses: number;
    tokens: number;
    failure: string | undefined;
    // A re-run of this same turn the sandbox booked for itself, as its failure frame states it.
    rerun: { readonly at?: number | undefined } | undefined;
    // Whether the provider answered at all: what proves its lane to the fan-out governor.
    answered: boolean;
    // The failure frame's code, which says whether a wait answers it (a spent allowance) or nothing here does.
    code: string | undefined;
    // Whether its parent was told this turn runs on another model than it was spawned on.
    substituted: boolean;
    // Whether the failure came as an error frame of its turn, rather than a start the sandbox could not make.
    errored: boolean;
}

const freshTally = (): ChildTurnTally => ({ bubble: "", report: "", toolUses: 0, tokens: 0, failure: undefined, rerun: undefined, answered: false, code: undefined, substituted: false, errored: false });

// The first frame the provider itself produced proves the child's lane, and starts whatever waited on it.
const takeAnswer = (childId: string, tally: ChildTurnTally, event: AgentEvent): void => {
    if (tally.answered || !ANSWERS.has(event.kind) || ("parentToolUseId" in event && event.parentToolUseId !== undefined)) {
        return;
    }
    tally.answered = true;
    FAN_OUT.answered(childId);
};
const ANSWERS: ReadonlySet<AgentEvent["kind"]> = new Set(["delta", "thinking", "tool_call"]);

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

// Wakes the parent with a question its child parked on, where no wait of the parent's took it: a parent with no live turn
// hears of nothing else until the child ends, so the child would sit blocked until a person happened to look. Said
// through the door a child's report takes (child-report.ts): into the parent's live turn, else a turn of its own.
// `reported` files the move as handed over once the parent has it, so a later wait does not return it again. Never
// throws: it runs off a frame of the child's turn, which must not fail with it.
const askParent = async (
    services: Services,
    childId: string,
    kid: ChildRecord,
    questions: readonly AskQuestion[],
    reported: () => void,
): Promise<void> => {
    const entry = services.agents.entry(kid.parent);
    if (entry === undefined || entry.archivedAt !== undefined) {
        return;
    }
    try {
        const receipt = await deliverWake(
            { turns: services.turns },
            {
                conversationId: kid.parent,
                prompt: questionWords(childId, kid.spec, questions),
                voice: "sandbox",
                source: "subagents",
                profile: conversationProfile(entry),
            },
        );
        if ("invalid" in receipt || "why" in receipt) {
            services.logger.info(
                { child: childId, parent: kid.parent, receipt },
                "child question: its parent took nothing, it waits on a wait or the owner",
            );
            return;
        }
        reported();
    } catch (error) {
        services.logger.warn({ err: error, child: childId }, "child question: could not be said to its parent");
    }
};

// A card the child parked on: blocked, saying on what, with the whole card kept for `answer`. A question no parked wait
// took also wakes the parent, which is the one to answer it; a permission or plan card is the owner's, and the owner's
// own devices hear of it (the awaiting push), never the parent.
const takeParked = (services: Services, childId: string, kid: ChildRecord | undefined, event: AgentEvent): void => {
    const parked = pendingOf(event);
    if (parked === undefined) {
        return;
    }
    if (kid !== undefined) {
        kid.pending = parked.card;
    }
    noteSpawnedChild(services.conversations, childId, { status: "blocked", summary: parked.summary });
    // Asked in the same step as the move: a wait answers inside it, so nothing can take the move in between.
    const reported = parked.card.kind === "question" ? blockedMoveReporter(services.conversations, childId) : undefined;
    if (kid !== undefined && reported !== undefined) {
        void askParent(services, childId, kid, parked.card.questions ?? [], reported);
    }
};

// One frame of a child's turn onto its roster row and its tally. Normalized frames make this work across providers, and
// a child's own sub-delegations still count as its proof.
const takeChildFrame = (services: Services, childId: string, kid: ChildRecord | undefined, tally: ChildTurnTally, event: AgentEvent): void => {
    noteChildWork(services.conversations, event, childId);
    takeAnswer(childId, tally, event);
    switch (event.kind) {
        case "init":
            takeServedModel(services, childId, kid, tally, event.model);
            return;
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
            tally.code = event.code;
            tally.errored = true;
            tally.rerun = event.autoResume === "scheduled" ? { at: event.nextAt } : undefined;
            if (kid !== undefined && movesOn(kid, event)) {
                kid.movingOn = { failure: event.message };
            }
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

// How often a paused child looks whether the re-run it waits for is still coming, and how many looks in a row may find
// it gone before the pause ends as failed; two, since a re-run firing is a moment with no hold and no run yet.
const PAUSE_LOOK_MS = 15_000;
const PAUSE_MISSES = 2;

/**
 * Ends a child's pause, whatever ends it: its re-run starting, a message from its parent, a cancel (its parent's, or its
 * family's as a parent leaves), or the re-run lapsing. Struck off the record a restart reads too, so the next boot does
 * not tell its parent about a pause that already ended.
 */
const endPause = (kid: ChildRecord): void => {
    if (kid.paused !== undefined) {
        clearInterval(kid.paused.look);
        kid.paused.unrecord();
        kid.paused = undefined;
    }
};

// A turn that ended on a wall the sandbox re-runs it past by itself is paused, not finished: its row stays live so its
// parent's wait keeps covering it, says when the re-run comes and how to stop it, and ends as failed if it never does.
// Written down while it stands, since a restart clears the booking and this look with it (paused-children.ts).
const pauseChild = (services: Services, childId: string, parent: string, kid: ChildRecord, failure: string, error: string): void => {
    endPause(kid);
    noteSpawnedChild(services.conversations, childId, { status: "paused", summary: `Paused, not finished. ${error}`, error });
    const ledger = filePausedChildren(services.config.historyRoot, services.logger);
    void ledger.note(childId, { parent, failure }, Date.now());
    let misses = 0;
    const look = setInterval(() => {
        // Its record went with a dispose (its own conversation's, or its parent's): nobody is left to tell. The pause
        // itself stands, for the family's cancel that follows a parent's discard to find and end (cancelFamily).
        if (kid.paused?.look !== look || services.conversations.holdings(CHILDREN).get(childId) !== kid) {
            clearInterval(look);
            return;
        }
        const held = services.conversations.state(childId)?.resume.held;
        const gone = liveRunOf(services.conversations, childId) === undefined && (held === undefined || held.fired);
        misses = gone ? misses + 1 : 0;
        if (misses < PAUSE_MISSES) {
            return;
        }
        const ranElsewhere = turnRunOf(services.conversations, childId)?.id !== kid.paused.run;
        endPause(kid);
        const lapsed = `${failure} ${noRerun(ranElsewhere)}`;
        settleSpawnedChild(services.conversations, childId, { status: "failed", report: kid.report ?? "", error: lapsed });
        void sayToParent(services, parent, `Your subagent \`${childId}\` ("${taskLine(kid.spec)}") stays stopped: ${lapsed}`);
    }, PAUSE_LOOK_MS);
    look.unref();
    kid.paused = { failure, run: turnRunOf(services.conversations, childId)?.id, look, unrecord: () => void ledger.forget([childId]) };
};

/** How a child's turn ended, in the words its parent reads, and whether a re-run is booked past it. */
interface ChildEnding {
    // The whole sentence: what ended it, then the re-run or where else the task could go.
    readonly error: string | undefined;
    // Set only where the sandbox booked one, which is what makes the child paused rather than failed.
    readonly rerun: string | undefined;
}

// A cancel and an outside kill each explain themselves; anything else is the child's own ending, dressed with the
// re-run that is coming or, where none is, somewhere the task could go instead.
const childEnding = async (
    services: Services,
    childId: string,
    kid: ChildRecord | undefined,
    tally: ChildTurnTally,
    outside: { readonly cancelled: boolean; readonly killed: string | undefined },
): Promise<ChildEnding> => {
    if (outside.cancelled) {
        return { error: CANCELLED, rerun: undefined };
    }
    if (outside.killed !== undefined) {
        return { error: outside.killed, rerun: undefined };
    }
    const failure = tally.failure;
    if (failure === undefined) {
        return { error: undefined, rerun: undefined };
    }
    const rerun = tally.rerun === undefined ? undefined : bookedRerunWords(tally.rerun, childId);
    // Only where nothing is bringing it back: with a re-run booked, where else it could go is noise.
    const elsewhere = rerun !== undefined ? undefined : await elsewhereFor(services, childId, kid?.spec, failure);
    return { error: [failure, rerun, elsewhere].filter((part) => part !== undefined).join(" "), rerun };
};

// A turn that opens on another model than its child was spawned on is said to the parent at once, never left to the
// row: a re-run of a Kimi child once ran on kimi-k3 after kimi-k3-256k was taken off the list, and nothing said so
// (2026-10-17).
const takeServedModel = (services: Services, childId: string, kid: ChildRecord | undefined, tally: ChildTurnTally, served: string): void => {
    const asked = kid?.spec.model;
    if (kid === undefined || tally.substituted || asked === undefined || asked === "" || sameModel(served, asked)) {
        return;
    }
    tally.substituted = true;
    void sayToParent(
        services,
        kid.parent,
        `Your subagent \`${childId}\` ("${taskLine(kid.spec)}") runs this turn on ${served}, not on ${asked} as it was spawned: ${asked} was not offered when the turn started. Cancel it if that model will not do.`,
    );
};

// Onto the first fallback the records do not call spent and the owner's rules let through without a card (a move the
// owner must allow is theirs to make, not the sandbox's), its seat given back first since the move takes one of its own.
// Answers whether it moved; a child that could not is put back on what it ran on.
const moveOnward = async (services: Services, childId: string, parent: string, kid: ChildRecord, failure: string, giveSeatBack: () => void): Promise<boolean> => {
    const from = kid.spec;
    const options = from.fallbacks ?? [];
    for (const [index, option] of options.entries()) {
        const target = rehomedSpec(from, option, options.slice(index + 1));
        if ((await spentAsked(services, target)) !== undefined || (await judgeMove(services, parent, target.provider)).effect !== "allow") {
            continue;
        }
        giveSeatBack();
        rehomeChild(services, childId, kid, target);
        const sent = await followUp(services, { conversationId: parent, cwd: kid.cwd }, kid, childId, carryOnWords(from, kid.spec, failure));
        if (sent.ok) {
            void sayToParent(
                services,
                parent,
                `Your subagent \`${childId}\` ("${taskLine(from)}") was refused on ${from.provider}/${from.model} and moved itself to ${kid.spec.provider}/${kid.spec.model}, the next of the fallbacks you gave it: it carries on in the same worktree, and its report comes when that turn ends. The refusal: ${failure}`,
            );
            return true;
        }
        kid.spec = from;
        kid.profile = childProfile(from);
        return false;
    }
    return false;
};

// Settles a child's turn from its tally: its closing text as the report, a kill named from outside, a re-run the sandbox
// booked making it paused rather than failed, and its seat freed.
const settleChildTurn = async (
    services: Services,
    childId: string,
    parent: string,
    kid: ChildRecord | undefined,
    tally: ChildTurnTally,
): Promise<void> => {
    const whole = (tally.bubble.trim() !== "" ? tally.bubble : tally.report).trim();
    const closing = whole.slice(0, REPORT_KEPT);
    // Read while the record still says running, so a `send` cannot start a follow-up this settle then overwrites.
    const killed = tally.failure === undefined ? undefined : await childKillNote(services, childId, tally.failure);
    const cancelled = kid?.cancelled === true;
    FAN_OUT.ended(childId, { answered: tally.answered, failure: cancelled ? undefined : providerRefusal(tally) });
    const giveSeatBack = onceOnly(() => freeSeat(services, parent));
    const moving = await movedOn(services, { childId, parent, kid, whole }, { cancelled, killed }, giveSeatBack);
    if (moving === "moved") {
        return;
    }
    const { error, rerun } = await childEnding(services, childId, kid, tally, { cancelled, killed });
    if (kid !== undefined) {
        kid.running = false;
        kid.queued = false;
        kid.pending = undefined;
        kid.cancelled = false;
        kid.report = whole.slice(0, REPORT_WHOLE);
    }
    if (rerun !== undefined && tally.failure !== undefined && error !== undefined && kid !== undefined) {
        pauseChild(services, childId, parent, kid, tally.failure, error);
    } else {
        settleSpawnedChild(services.conversations, childId, {
            status: cancelled || killed !== undefined ? "killed" : tally.failure !== undefined ? "failed" : "completed",
            report: closing,
            ...opt("error", error),
        });
    }
    giveSeatBack();
    // Its report was held back while it was to move (child-report.ts): the parent hears how it ended after all.
    if (moving === "stayed" && error !== undefined && kid !== undefined) {
        void sayToParent(services, parent, `Your subagent \`${childId}\` ("${taskLine(kid.spec)}") stays stopped: none of its fallbacks could take it. ${error}`);
    }
};

// A child whose refusal its fallbacks answer is moved before its turn settles: `moved` ends the settle there, `stayed`
// settles it as it ended and tells its parent, whose report was held back for the move; undefined is no move at all.
const movedOn = async (
    services: Services,
    ended: { readonly childId: string; readonly parent: string; readonly kid: ChildRecord | undefined; readonly whole: string },
    outside: { readonly cancelled: boolean; readonly killed: string | undefined },
    giveSeatBack: () => void,
): Promise<"moved" | "stayed" | undefined> => {
    const { childId, parent, kid, whole } = ended;
    const moving = kid?.movingOn;
    if (kid === undefined || moving === undefined) {
        return undefined;
    }
    if (outside.cancelled || outside.killed !== undefined) {
        kid.movingOn = undefined;
        return undefined;
    }
    kid.running = false;
    kid.report = whole.slice(0, REPORT_WHOLE);
    const moved = await moveOnward(services, childId, parent, kid, moving.failure, giveSeatBack);
    kid.movingOn = undefined;
    return moved ? "moved" : "stayed";
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

// Admits one child turn to the box: undefined once there is room, else why there is none. Admitted here, where the wait
// can be shown on the child's row, and kept for the door, which takes this admission instead of judging the same turn a
// second time. A child placed on a runner holds nothing here.
const admitRoom = async (services: Services, childId: string, kid: ChildRecord | undefined, where: WorkPlace): Promise<string | undefined> => {
    if (kid !== undefined) {
        kid.queued = true;
    }
    const room = await services.resources.admit({
        workload: "agentRuntime",
        attended: false,
        owner: childId,
        where,
        forTurn: true,
        wait: {
            onShort: (diagnosis) =>
                noteSpawnedChild(services.conversations, childId, { status: "pending", summary: `Waiting for memory: ${diagnosis}.` }),
        },
    });
    if (kid !== undefined) {
        kid.queued = false;
    }
    if (room.verdict !== "run") {
        return room.message;
    }
    if (room.waitedMs > 0) {
        noteSpawnedChild(services.conversations, childId, { status: "running", summary: "" });
    }
    return undefined;
};

// How long a wait for memory may run before the records are asked again whether the child's model is still askable.
const STALE_ADMISSION_MS = 30_000;

// Admits one child turn to the box and starts it once its conversation is free, or says in the tally why it did not.
const admitAndStart = async (
    services: Services,
    childId: string,
    kid: ChildRecord | undefined,
    turn: TurnInput & { conversationId: string },
    where: WorkPlace,
    tally: ChildTurnTally,
): Promise<StartedChildTurn | undefined> => {
    const queuedAt = Date.now();
    const short = await admitRoom(services, childId, kid, where);
    if (short !== undefined) {
        tally.failure = short;
        return undefined;
    }
    if (kid?.cancelled === true) {
        tally.failure = NOT_STARTED.cancelled;
        return undefined;
    }
    // A start that waited for memory is asked of the records again: what was askable when it queued may be spent now.
    const spent = Date.now() - queuedAt < STALE_ADMISSION_MS || kid === undefined ? undefined : await spentAsked(services, kid.spec);
    if (spent !== undefined) {
        tally.failure = `Not started after waiting for memory, and nothing spent on it: ${spent}`;
        return undefined;
    }
    if (kid !== undefined) {
        kid.oomKillsAtStart = (await services.resources.snapshot(0)).reading.oomKills;
    }
    // The parent's agent asked for it, never a person.
    const start = await startWhenFree(services, childId, kid, turn, () => admitRoom(services, childId, kid, where));
    if ("refused" in start) {
        tally.failure = start.refused;
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

// The roster handle a child's records are filed through: under its parent.
const rosterHandle = (services: Services, parent: string): SubagentTurn => ({
    conversationId: parent,
    conversations: services.conversations,
    subagentsDir: undefined,
});

// A child's roster row as it opens: named by its task, wearing its provider's label and its model. Every turn of the
// child reopens it the same way, so a follow-up never retitles it with its own words.
const childBirth = (id: string, spec: ChildSpawnSpec, depth: number): SpawnedChildBirth => {
    const { provider, model } = childRouting(spec);
    return { id, description: taskLine(spec), agentType: labelOf(provider), provider, spawnDepth: depth, model };
};

/**
 * A turn that starts on a spawned child without its parent (a re-run the sandbox fired itself once an allowance reopened
 * or a turn stopped short, a watch it left, another conversation's message) is still the
 * parent's to supervise: the child's row reopens and counts as live, its ending reaches the parent like any other, and a
 * parent with a live turn hears that it is working, so it neither sends the task again nor hands it to another agent. A
 * person's own turn in the child's chat stays theirs, and a turn the parent started is already followed.
 */
export const adoptChildTurn = (services: Services, started: DomainEventMap["run.started"]): void => {
    const childId = started.conversationId;
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    const run = liveRunOf(services.conversations, childId);
    if (started.speaker?.kind === "person" && run !== undefined && parentOfActor(services.agents.entry(childId)?.identity.startedBy) !== undefined) {
        services.conversations.holdings(PERSON_RUNS).hold(childId, childId, run.id);
    }
    if (kid === undefined || kid.running || run === undefined || started.speaker?.kind === "person") {
        return;
    }
    endPause(kid);
    kid.running = true;
    kid.startedAt = Date.now();
    const seats = services.conversations.holdings(SEATS);
    const ledger = seats.get(kid.parent) ?? { live: 0, total: 0 };
    seats.hold(kid.parent, kid.parent, { live: ledger.live + 1, total: ledger.total });
    openSpawnedChild(rosterHandle(services, kid.parent), { ...childBirth(childId, kid.spec, kid.depth), again: true });
    void followChildRun(services, childId, kid.parent, kid, run, freshTally());
    void sayToParent(
        services,
        kid.parent,
        `Your subagent \`${childId}\` ("${taskLine(kid.spec)}") is working: ${startedWhy(started)}. Its report reaches you when it ends, like any turn of its: do not send it the task again or give the task to another agent meanwhile.`,
    );
};

// A supervisor move let through; `run` is set only when the owner re-pointed a start on the card, and is then the whole
// run to start the child on in place of the agent's.
type Admission = { readonly ok: true; readonly run?: ChildRun } | { readonly ok: false; readonly message: string };

// What the owner's rules and the taint floor say of a move before anybody is asked.
type MoveVerdict =
    { readonly effect: "allow" } | { readonly effect: "deny"; readonly message: string } | { readonly effect: "hold"; readonly reason: string };

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

// The grant answers the cards already up on that provider in that turn as well as the moves still to come: four starts
// held side by side are one decision, not four presses of the same caret.
const releaseHeldMoves = (
    services: Pick<Services, "conversations" | "cards">,
    parent: string,
    run: string,
    provider: string,
    caller: Caller | undefined,
): void => {
    for (const held of services.conversations.holdings(HELD_MOVES).of(parent)) {
        if (held.run === run && held.provider === provider) {
            services.cards.resolve({ kind: "permission", requestId: held.requestId, decision: "always" }, caller);
        }
    }
};

// Consulted before every supervisor mutation (spawn, send, answer): the owner's action rules plus the taint floor. A hold
// the owner already allowed for the rest of this turn lets the move through.
const judgeMove = async (services: Services, parent: string, provider: string): Promise<MoveVerdict> => {
    const settings = await services.sandboxSettings.get();
    const verdict = guard(childSpawn, { provider, rules: settings.actionRules, ...opt("outsideSource", conversationTaintSource(parent)) });
    if (verdict.effect === "deny") {
        return { effect: "deny", message: `Refused: ${verdict.reason}.` };
    }
    return verdict.effect === "hold" && !turnAllows(services.conversations, parent, provider)
        ? { effect: "hold", reason: verdict.reason }
        : { effect: "allow" };
};

// A provider the owner's rules refuse stays refused when it was picked on the card: the card overrides the agent's
// choice, never the rulebook. A hold is already answered, since the owner is the one who picked it.
const refusedByRules = async (services: Services, provider: string): Promise<string | undefined> => {
    const settings = await services.sandboxSettings.get();
    const verdict = guard(childSpawn, { provider, rules: settings.actionRules });
    return verdict.effect === "deny" ? `Refused: ${verdict.reason}.` : undefined;
};

// Raises the card on the parent's live turn and settles with the owner's answer, however long that takes; nobody's call
// waits on it. The two refusals differ because the model's next move differs, and only one is the owner declining.
const askOwner = async (services: Services, parent: string, run: LiveRun, ask: ChildAgentAsk, reason: string): Promise<Admission> => {
    const { move, provider } = ask;
    const ended = new AbortController();
    void run.waitUntilFinished().then(() => ended.abort());
    let held: string | undefined;
    const settled = raiseRequest(
        cardDeps(services),
        { conversationId: parent, push: (event) => run.push(event) },
        {
            kind: "permission",
            onAbort: { kind: "permission", requestId: "", decision: "deny", feedback: "The turn ended before you answered." },
            raised: (requestId) => {
                // Filed as the card goes up, which is the one moment its id is known before the answer.
                held = requestId;
                services.conversations.holdings(HELD_MOVES).hold(parent, requestId, { requestId, run: run.id, provider });
                return {
                    kind: "permission",
                    requestId,
                    toolName: "agents.spawn",
                    title: `${MOVE_TITLE[move]} on ${labelOf(provider)}?`,
                    displayName: MOVE_BUTTON[move],
                    reason,
                    alwaysLabel: ALWAYS_LABEL,
                    child: ask,
                };
            },
            approves: (answer) => answer.decision !== "deny",
            signal: ended.signal,
        },
    );
    const { decision, reply, caller } = await settled.finally(() => {
        if (held !== undefined) {
            services.conversations.holdings(HELD_MOVES).drop(held);
        }
    });
    switch (decision) {
        case "approved": {
            if (reply.decision === "always") {
                grantTurn(services.conversations, parent, run.id, provider);
                releaseHeldMoves(services, parent, run.id, provider, caller);
            }
            // Only a start can be re-pointed: a child already running keeps the run it was started on (childProfile).
            const picked = move === "spawn" ? reply.child : undefined;
            return picked !== undefined && !sameChildRun(ask, picked) ? { ok: true, run: childRunOf(picked) } : { ok: true };
        }
        case "unanswered":
            return { ok: false, message: unansweredWords(move, reason) };
        case "declined":
            return {
                ok: false,
                message: `The owner declined this. Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
            };
    }
};

// A child on a runtime with rulebook "none" has no gating of its own, so the parent's turn taints, the same as reading
// a fetched page. No loop today lacks a seam (each has hooks or an approval channel); the floor stays for one that does.
export const composeRuntimeFloor = (parent: string, provider: AgentProvider, capabilities: Pick<AgentCapabilities, "rulebook">): void => {
    if (capabilities.rulebook === "none") {
        markConversationTaint(parent, `${RUNTIME_SOURCE}${provider}`);
    }
};

// Reads and reserves the live/lifetime budget in one synchronous step so two concurrent spawns cannot both pass the
// same check. `release` refunds only a reservation whose turn never started. `limitPolicy` is the sandbox's standing
// answer to a spent allowance, from the same read, which the admitted turn opens by (childOpening): no second read
// comes between the seat and the turn that takes it.
const admitChildTurn = async (
    services: Services,
    parent: string,
): Promise<
    { readonly ok: true; readonly release: () => void; readonly limitPolicy: LimitPolicy } | { readonly ok: false; readonly message: string }
> => {
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
    // Once only: a start the governor held and then failed to start can reach two refunds for the one seat.
    let refunded = false;
    return {
        ok: true,
        limitPolicy: settings.limitPolicy,
        release: (): void => {
            if (refunded) {
                return;
            }
            refunded = true;
            const now = seats.get(parent);
            if (now !== undefined) {
                seats.hold(parent, parent, { live: Math.max(0, now.live - 1), total: Math.max(0, now.total - 1) });
            }
        },
    };
};

// What the gate's card says about a child: its run, task and machine off the call's spec or the child's own record,
// never the parent's prose about them.
const childAsk = (move: ChildMove, spec: ChildSpawnSpec): ChildAgentAsk => {
    const ask: ChildAgentAsk = { move, ...childRunOf(spec), task: taskLine(spec) };
    if (spec.on !== undefined) {
        ask.on = spec.on;
    }
    return ask;
};

// A start, with the prompt it would open on: what the owner is really allowing. A start the parent did not describe is
// already titled by that prompt's head, so it quotes nothing a second time.
const startAsk = (spec: ChildSpawnSpec): ChildAgentAsk =>
    spec.description === undefined ? childAsk("spawn", spec) : { ...childAsk("spawn", spec), message: quoted(spec.prompt) };

// The same for a child that already exists, with the words the parent would say to it.
const askAbout = (kid: ChildRecord, move: ChildMove, childId: string, message: string): ChildAgentAsk => ({
    ...childAsk(move, kid.spec),
    child: childId,
    message: quoted(message),
});

// Whether the privacy shield keeps children on this machine; an unreadable policy keeps them here too.
const shieldHoldsHere = async (services: Pick<Services, "privacyShield">): Promise<boolean> => {
    try {
        return (await services.privacyShield.policy()).mode !== "off";
    } catch {
        // allow(silent-catch): an unreadable policy may be one that is on, and a child kept here costs only a slot.
        return true;
    }
};

// The runner a child goes to, undefined for here. No preference: the scheduler places it. A named machine gets it, or
// here if that machine is unusable.
const childPlacement = async (
    services: Services,
    spec: ChildSpawnSpec,
    provider: AgentProvider,
    harness: AgentHarness,
): Promise<string | undefined> =>
    // A runner calls its provider from its own machine, past this sandbox's privacy shield, so while the shield is on
    // or watching every child stays here, wherever it was asked to go.
    spec.on === "here" || (await shieldHoldsHere(services))
        ? undefined
        : placeFanOut(
              await freshRunnerSummaries(services),
              { inFlight: services.conversations.inFlightByRunner() },
              {
                  ...(spec.on !== undefined ? { asked: spec.on } : {}),
                  // A credential that cannot travel keeps the child here unless a machine is named explicitly.
                  travels: credentialsTravel(provider, harness),
              },
          ).runner;

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
        report: undefined,
        cancelled: false,
        movingOn: undefined,
        paused: undefined,
    };
};

// A start the gate let through, or held until the owner answers: what was asked, how deep it goes, and the id it runs as.
interface ChildStart {
    readonly asked: ChildSpawnSpec;
    readonly depth: number;
    readonly id: string;
}

// A seat reserved for a child's turn (admitChildTurn): what a start held by the governor keeps while it waits, so a held
// child costs its parent's budgets exactly as a running one does, and refunds it if it never starts.
type Seat = Extract<Awaited<ReturnType<typeof admitChildTurn>>, { readonly ok: true }>;

type GovernedStart = ChildStart & { readonly spec: ChildSpawnSpec; readonly repointed?: ChildRun };

// A start the governor let go, or held on its lane (fan-out-governor.ts) with its seat. Undefined lets it start now; a
// held one is filed as a waiting child, and its result says why and that it starts by itself.
const governedStart = async (services: Services, parent: ChildParent, start: GovernedStart, seat: Seat): Promise<ChildSpawnResult | undefined> => {
    const lane: Lane = { provider: start.spec.provider, model: start.spec.model };
    const admission = FAN_OUT.admit(start.id, lane, capForRoom(await bestRoomFor(services, start.spec.provider, lane.model)));
    if (admission.go) {
        return undefined;
    }
    holdOnLane(services, parent, { ...start, seat }, lane, admission.reason);
    const news = siblingNewsWords(FAN_OUT.news(lane.provider));
    return {
        ok: true,
        id: start.id,
        held: true,
        note: [laneHeldNote(start.id, admission.reason), news].filter((part) => part !== undefined).join(" "),
    };
};

// Filed as a waiting child, so `wait` parks on it and `send` says why it has not started; the governor starts it.
const holdOnLane = (services: Services, parent: ChildParent, start: GovernedStart & { readonly seat: Seat }, lane: Lane, reason: string): void => {
    services.conversations.holdings(CHILDREN).hold(parent.conversationId, start.id, childRecordOf(parent, start.spec, start.depth, "lane"), start.id);
    openSpawnedChild(rosterHandle(services, parent.conversationId), childBirth(start.id, start.spec, start.depth), true);
    noteSpawnedChild(services.conversations, start.id, { status: "pending", summary: `Held: ${reason}.` });
    const giveUp = async (why: string): Promise<void> => {
        start.seat.release();
        await abandonChildStart(services, parent.conversationId, start.id, why);
    };
    FAN_OUT.hold({
        childId: start.id,
        lane,
        // Asked of the records again first: the sibling it waited on may have filed the refusal that makes it pointless.
        start: async () => {
            try {
                const spent = await spentAsked(services, start.spec);
                const started = spent === undefined ? await startChild(services, parent, start) : { ok: false as const, message: spent };
                if (!started.ok) {
                    await giveUp(`Not started, and nothing spent on it: ${started.message}`);
                }
                return started.ok;
            } catch (error) {
                await giveUp(errorMessage(error));
                return false;
            }
        },
        abandon: giveUp,
        cancel: () => start.seat.release(),
    });
};

// Starts a child the gate let through: on the owner's pick when they re-pointed it (`repointed`), else as asked. `seat`
// is the one a start the governor held kept while it waited; it is already counted on its lane.
const startChild = async (services: Services, parent: ChildParent, start: GovernedStart & { readonly seat?: Seat }): Promise<ChildSpawnResult> => {
    const { asked, spec, depth, id, repointed } = start;
    if (spec.provider !== asked.provider) {
        const refused = await refusedByRules(services, spec.provider);
        if (refused !== undefined) {
            return { ok: false, message: refused };
        }
    }
    const admitted = start.seat ?? (await admitChildTurn(services, parent.conversationId));
    if (!admitted.ok) {
        return admitted;
    }
    const governed = start.seat === undefined ? await governedStart(services, parent, start, admitted) : undefined;
    if (governed !== undefined) {
        return governed;
    }
    const { provider, harness } = childRouting(spec);

    // Seat is claimed here; every exit must hand it to a running turn or refund it, or the cap drops permanently.
    let handedOff = false;
    try {
        composeRuntimeFloor(parent.conversationId, provider, capabilitiesOf(provider, harness));
        const placement = await childPlacement(services, spec, provider, harness);
        const record = childRecordOf(parent, spec, depth);
        const turn: TurnInput & { conversationId: string } = {
            prompt: spec.prompt,
            conversationId: id,
            // By the settings as it starts, which for a start the owner allowed later is when they allowed it.
            ...childOpening(spec, admitted.limitPolicy),
            // Its starter is the parent, which is also how it inherits the parent's owner (agents-registry.ts).
            ...spokenBy({ kind: "agent", conversationId: parent.conversationId }),
            ...opt("placement", placement === undefined ? undefined : { kind: "runner" as const, id: placement }),
            ...record.profile,
        };
        services.conversations.holdings(CHILDREN).hold(parent.conversationId, id, record, id);
        // Files under the parent's conversation, what `wait` matches; a held start's waiting row gives way to this one.
        openSpawnedChild(rosterHandle(services, parent.conversationId), childBirth(id, spec, depth), true);
        runChildTurn(services, id, parent.conversationId, turn, placement === undefined ? "local" : { runner: placement });
        handedOff = true;
        const note = [
            repointed === undefined ? undefined : repointedNote(childRunOf(asked), repointed),
            siblingNewsWords(FAN_OUT.news(provider)),
        ].filter((part) => part !== undefined);
        return note.length === 0 ? { ok: true, id } : { ok: true, id, note: note.join(" ") };
    } finally {
        if (!handedOff) {
            admitted.release();
            FAN_OUT.ended(id, { answered: false, failure: undefined });
        }
    }
};

// A start waiting on the owner, filed as a child already, so `wait` parks on it and `send` refuses it with the reason.
const holdChildStart = (services: Services, parent: ChildParent, start: ChildStart): void => {
    services.conversations
        .holdings(CHILDREN)
        .hold(parent.conversationId, start.id, childRecordOf(parent, start.asked, start.depth, "start"), start.id);
    openSpawnedChild(rosterHandle(services, parent.conversationId), childBirth(start.id, start.asked, start.depth));
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
    if (await sayToParent(services, parent, `Your subagent \`${id}\` did not start: ${message}`)) {
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
            void sayToParent(services, parent.conversationId, `The owner allowed your subagent \`${start.id}\` to start. ${started.note}`);
        }
    } catch (error) {
        await abandonChildStart(services, parent.conversationId, start.id, errorMessage(error));
    }
};

/**
 * Starts a child agent and returns once it is queued; on a box short of memory it waits as `pending` before its turn
 * runs. Budget/depth refusals and a model the records call spent come back immediately; any other provider refusal
 * surfaces later as the child's own failure. A start the owner must allow comes back at once as well, `held`, its row
 * waiting until they answer.
 */
export const spawnChild = async (services: Services, parent: ChildParent, asked: ChildSpawnSpec): Promise<ChildSpawnResult> => {
    const settings = await services.sandboxSettings.get();
    const depth = spawnDepthOf(services.conversations, parent.conversationId) + 1;
    if (depth > settings.subagentDepth) {
        return {
            ok: false,
            message: `Spawn depth ${settings.subagentDepth} reached: this agent is itself a spawned subagent and may not go deeper.`,
        };
    }
    const spent = await spentAsked(services, asked);
    if (spent !== undefined) {
        return { ok: false, message: spent };
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
    void askOwner(services, parent.conversationId, run, startAsk(asked), verdict.reason).then((admission) =>
        startAllowed(services, parent, start, admission),
    );
    return { ok: true, id: start.id, held: true, note: heldStart(verdict.reason) };
};

// Why a message cannot go to the child yet, whatever the owner's rules say; undefined when it can.
const notYet = (kid: ChildRecord): string | undefined => {
    if (kid.held === "lane") {
        return "It has not started: it waits for a sibling on its provider to be answered first, or for a seat on it to free. Wait for it, then send again.";
    }
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
    composeRuntimeFloor(parent.conversationId, kid.spec.provider, capabilitiesOf(kid.spec.provider, childRouting(kid.spec).harness));
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
            // Ignored by a conversation already open. When the first turn never opened it (refused for memory, turned
            // away, or ended before it got that far), this one does, and opens it as the spawn would have.
            ...childOpening(kid.spec, admitted.limitPolicy),
            // Its parent asked, as for the spawn: the settled turn reports back to that parent (child-report.ts).
            ...spokenBy({ kind: "agent", conversationId: parent.conversationId }),
            ...kid.profile,
            // Session from the last turn's report; absent falls back to the ordinary reopened-conversation seed.
            ...opt("sessionId", kid.sessionId),
        };
        // A message supersedes a re-run the sandbox booked for it: the turn it opens is the one its parent waits on.
        endPause(kid);
        // Reopens the roster record under the same id with fresh state, so `wait` sees it running again. It keeps the
        // spawn's own description; what this turn was asked rides as the row's summary until its report replaces it.
        openSpawnedChild(rosterHandle(services, parent.conversationId), { ...childBirth(childId, kid.spec, kid.depth), again: true });
        noteSpawnedChild(services.conversations, childId, { summary: `Follow-up: ${taskLine({ prompt: message })}` });
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
                ? "Sent, to run next: it is busy with a turn it did not get from you (a person, a land conflict or a failing check sent back to it), and your message runs as its own follow-up once that ends. Supervise it with wait."
                : "Sent: the child runs a follow-up turn, once there is memory for it. Supervise it with wait.",
        };
    } finally {
        if (!handedOff) {
            admitted.release();
        }
    }
};

/* RE-HOMING A CHILD: its next turn on another provider and model, in the same worktree. 2026-10-17: a parent whose
   children were refused on four providers rescued their work by hand, re-spawning twelve of them with replacement
   prompts and copying seven patches across worktrees, because `send` could only continue a child where it was. */

// Why a child cannot move now; undefined when it can. Between turns only: a turn under way stays where it runs.
const unmovable = (kid: ChildRecord): string | undefined =>
    kid.running
        ? "It is mid-turn: a child moves between turns only. Cancel it (its work stays in its worktree), then send again naming the provider and model."
        : notYet(kid);

// Moves a settled or paused child for its next turn: a re-run booked where it was is dropped, and its session stays
// with the provider that minted it, so the next turn opens a fresh one seeded from the child's own record (routing.ts
// sessionFor) on top of the same worktree.
const rehomeChild = (services: Pick<Services, "conversations">, childId: string, kid: ChildRecord, spec: ChildSpawnSpec): void => {
    if (kid.paused !== undefined) {
        endPause(kid);
        const held = services.conversations.state(childId)?.resume.held;
        if (held !== undefined && !held.fired) {
            services.conversations.send(childId, { kind: "resume-dropped" });
        }
    }
    const { provider, harness, model } = childRouting(spec);
    kid.spec = { ...spec, provider, harness, model };
    kid.profile = childProfile(spec);
    kid.sessionId = undefined;
};

// A message the gate let through: steered into the child's live turn, else a follow-up turn of its own, on `target` where
// the parent moved it.
const deliverToChild = async (
    services: Services,
    parent: ChildParent,
    kid: ChildRecord,
    childId: string,
    message: string,
    target?: ChildSpawnSpec,
): Promise<ChildActionResult> => {
    // Asked again: an owner answering later may find the child waiting on something new.
    const waiting = target === undefined ? notYet(kid) : unmovable(kid);
    if (waiting !== undefined) {
        return { ok: false, message: waiting };
    }
    const from = kid.spec;
    if (target !== undefined) {
        rehomeChild(services, childId, kid, target);
        const sent = await followUp(services, parent, kid, childId, message);
        return sent.ok ? { ok: true, note: `${movedWords(from, kid.spec)} ${sent.note ?? ""}`.trim() } : sent;
    }
    composeRuntimeFloor(parent.conversationId, kid.spec.provider, capabilitiesOf(kid.spec.provider, childRouting(kid.spec).harness));
    if (kid.running) {
        // Mid-turn, the only door is the runtime's own steering seam; a runtime without one cannot take words yet.
        return steerTurn(services.conversations, childId, { text: message, voice: "agent" })
            ? { ok: true, note: "Steered: the message lands between its tool calls." }
            : { ok: false, message: "It is mid-turn on a runtime that takes no mid-turn input: wait for it to finish, then send again." };
    }
    return followUp(services, parent, kid, childId, message);
};

// A held message once the owner answers: sent, or not, and the parent told when it did not go.
const sendAllowed = async (
    services: Services,
    parent: ChildParent,
    sent: { readonly kid: ChildRecord; readonly childId: string; readonly message: string; readonly target: ChildSpawnSpec | undefined },
    admission: Admission,
): Promise<void> => {
    const { kid, childId, message, target } = sent;
    kid.held = undefined;
    let outcome: ChildActionResult;
    try {
        outcome = admission.ok ? await deliverToChild(services, parent, kid, childId, message, target) : admission;
    } catch (error) {
        outcome = { ok: false, message: errorMessage(error) };
    }
    if (!outcome.ok) {
        void sayToParent(services, parent.conversationId, `Your message to subagent \`${childId}\` did not go: ${outcome.message}`);
    }
};

// Why an id reaches no child of this parent. Both kinds are listed alike (`list`), so an id naming a subagent its own
// runtime ran in-process is told apart from one naming nothing: it is this conversation's, and a service call cannot
// reach it.
const noSuchChild = (services: { readonly conversations: Actors }, parent: ChildParent, childId: string): ChildActionResult =>
    ranInProcess(services.conversations, parent.conversationId, childId)
        ? {
              ok: false,
              message:
                  "That subagent ran in-process, inside this conversation's own turn: it has no conversation of its own to message, answer or cancel. Only the turn that started it reaches it, through its runtime's own tools.",
          }
        : { ok: false, message: "No such child of this conversation. `list` shows yours." };

/**
 * Steers a working child, or sends a settled one a follow-up turn resuming its last reported session. Only the parent
 * that started it may reach it. A message the owner must allow comes back at once, and goes when they do.
 */
export const sendToChild = async (
    services: Services,
    parent: ChildParent,
    childId: string,
    message: string,
    rehome?: ChildRehome,
): Promise<ChildActionResult> => {
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    if (kid === undefined || kid.parent !== parent.conversationId) {
        return noSuchChild(services, parent, childId);
    }
    // A move is judged on where it goes: the records first, so a spent target is refused before any card is raised.
    const target = rehome === undefined ? undefined : rehomedSpec(kid.spec, rehome);
    const blocked = target === undefined ? undefined : (unmovable(kid) ?? (await spentAsked(services, target)));
    if (blocked !== undefined) {
        return { ok: false, message: blocked };
    }
    const verdict = await judgeMove(services, parent.conversationId, (target ?? kid.spec).provider);
    if (verdict.effect === "deny") {
        return { ok: false, message: verdict.message };
    }
    if (verdict.effect === "allow") {
        return deliverToChild(services, parent, kid, childId, message, target);
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
    void askOwner(services, parent.conversationId, run, askAbout({ ...kid, spec: target ?? kid.spec }, "send", childId, message), verdict.reason).then(
        (admission) => sendAllowed(services, parent, { kid, childId, message, target }, admission),
    );
    return { ok: true, note: heldMessage(verdict.reason) };
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
        return noSuchChild(services, parent, childId);
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
            void sayToParent(services, parent.conversationId, `Your answer to subagent \`${childId}\` did not go: ${answered.message}`);
        }
    });
    return { ok: true, note: heldAnswer(verdict.reason) };
};

/** Whether a child is moving itself onto a fallback: the run that just ended is not its parent's news yet. */
export const childMovingOn = (actors: Actors, childId: string): boolean => actors.holdings(CHILDREN).get(childId)?.movingOn !== undefined;

/** A child's last settled turn's whole closing message, for the wait that hands its ending over. */
export const childReportOf = (actors: Actors, childId: string): string | undefined => {
    const report = actors.holdings(CHILDREN).get(childId)?.report;
    return report === undefined || report === "" ? undefined : report;
};

/**
 * Brings a child's work into its parent's own checkout, leaving conflict markers where it clashes with the parent's
 * edits for the parent to resolve: the door a report or `wait` names when a child's land was held off the parent's tree,
 * as a runtime's worktree subagent hands its branch back for the parent to merge. Only the parent that started it may,
 * read off the registry so it outlives a restart, and only for a child whose work goes where the parent works.
 */
export const mergeChild = async (services: Services, parent: ChildParent, childId: string): Promise<ChildActionResult> => {
    const entry = services.agents.entry(childId);
    if (entry === undefined || !isIsolated(entry) || parentOfActor(entry.identity.startedBy) !== parent.conversationId) {
        return noSuchChild(services, parent, childId);
    }
    if (services.conversations.running(childId)) {
        return { ok: false, message: "It is still working: wait for it to finish, then merge what it did." };
    }
    const target = await landTargetOf(services, entry);
    if (target.kind === "main" && target.ruled) {
        return {
            ok: false,
            message:
                "Your checkout cannot take its work (you run on another machine, or it carries a repo you do not), so it lands the way any agent's does.",
        };
    }
    const result = await landByHandLeased(services, entry, "merge", "outstanding");
    const where = target.kind === "parent" ? "your checkout" : "the main tree";
    if (result.landed) {
        const open = (result.resolving ?? []).flatMap(({ repo, paths }) => paths.map((path) => (repo === "root" ? path : `${repo}/${path}`)));
        return {
            ok: true,
            note:
                open.length === 0
                    ? `Its changes are in ${where} now.`
                    : `Its changes are in ${where} now, with conflict markers to resolve in ${namedPaths(open)}.`,
        };
    }
    if (!result.changed) {
        return { ok: true, note: `Nothing of it is outstanding: ${where} already holds its work.` };
    }
    const blocked = (result.conflicts ?? []).flatMap(({ repo, paths }) => paths.map(({ path }) => (repo === "root" ? path : `${repo}/${path}`)));
    return {
        ok: false,
        message: `Nothing was written: ${blocked.length === 0 ? "the merge could not run" : `${namedPaths(blocked)} could not take conflict markers (a binary, or uncommitted edits that keep changing)`}. Its work stays on its branch \`agent/${childId}\`.`,
    };
};

// What a cancel reaches a child through: its conversation's actor, and the turn port's stop.
export interface ChildCancelDeps {
    readonly conversations: Pick<ConversationActors, "holdings" | "state" | "send">;
    readonly turns: Pick<Services["turns"], "stop">;
}

/**
 * Stops what a child of this parent is doing or is booked to do: its running turn, the start it waits on memory or
 * another turn for, or the re-run the sandbox booked for it after a spent allowance or a turn that stopped short. A start
 * or message still waiting on the owner's card is theirs to decline, not the parent's to withdraw.
 */
export const cancelChild = async (services: ChildCancelDeps, parent: ChildParent, childId: string): Promise<ChildActionResult> => {
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    if (kid === undefined || kid.parent !== parent.conversationId) {
        return noSuchChild(services, parent, childId);
    }
    return cancelRecord(services, childId, kid);
};

// The cancel of one child this daemon supervises, whoever asked for it: its parent, or the end of its family.
const cancelRecord = async (services: ChildCancelDeps, childId: string, kid: ChildRecord): Promise<ChildActionResult> => {
    // Held by the governor, not by the owner: the parent may take it back, and it never starts.
    if (kid.held === "lane" && FAN_OUT.withdraw(childId)) {
        services.conversations.holdings(CHILDREN).drop(childId);
        settleSpawnedChild(services.conversations, childId, { status: "killed", report: "", error: CANCELLED });
        return { ok: true, note: CANCEL_NOTES.waiting };
    }
    if (kid.held !== undefined) {
        return { ok: false, message: "It waits on the owner's card, which is theirs to answer: it does not go unless they allow it." };
    }
    if (kid.paused !== undefined) {
        const { failure } = kid.paused;
        endPause(kid);
        const held = services.conversations.state(childId)?.resume.held;
        if (held !== undefined && !held.fired) {
            services.conversations.send(childId, { kind: "resume-dropped" });
        }
        settleSpawnedChild(services.conversations, childId, { status: "killed", report: kid.report ?? "", error: `${failure} ${CANCELLED}` });
        return { ok: true, note: CANCEL_NOTES.paused };
    }
    if (!kid.running) {
        return { ok: false, message: "It is not running, and nothing is booked to run it again: there is nothing to cancel." };
    }
    kid.cancelled = true;
    const run = liveRunOf(services.conversations, childId);
    // Still waiting for memory, or for a turn somebody else started on it: its start sees the cancel and does not happen.
    if (run === undefined || kid.queued || kid.behind) {
        return { ok: true, note: CANCEL_NOTES.waiting };
    }
    await services.turns.stop({ conversationId: childId, run: run.id });
    return { ok: true, note: CANCEL_NOTES.running };
};

/** What a family's end reads and stops: the registry's spawn links, each child's conversation, and the turn port's stop. */
export interface FamilyDeps extends ChildCancelDeps {
    readonly agents: Pick<Services["agents"], "ids" | "entry">;
    readonly logger: Pick<Services["logger"], "info" | "warn">;
}

// A family as it stood while its heads were still on the board: every conversation below them, and the records of those
// this daemon supervises, which a head's dispose takes with it, since a child's record is held by its parent.
export interface Family {
    readonly heads: readonly string[];
    readonly members: readonly FamilyLink[];
    readonly records: ReadonlyMap<string, ChildRecord>;
}

/**
 * The family below these conversations: the children they spawned, theirs, and so on, by the registry's record of who
 * started whom, which outlives a restart, and by this daemon's own records, which hold a child whose first turn has not
 * opened its conversation yet. Read before the heads are forgotten.
 */
export const familyOf = (deps: Pick<FamilyDeps, "agents" | "conversations">, heads: readonly string[]): Family => {
    if (heads.length === 0) {
        return { heads, members: [], records: new Map() };
    }
    const kids = deps.conversations.holdings(CHILDREN);
    const links: FamilyLink[] = kids.entries().map(([child, kid]) => ({ child, parent: kid.parent }));
    for (const id of deps.agents.ids()) {
        const parent = parentOfActor(deps.agents.entry(id)?.identity.startedBy);
        if (parent !== undefined) {
            links.push({ child: id, parent });
        }
    }
    const members = descendantsOf(heads, links);
    const records = new Map<string, ChildRecord>();
    for (const { child } of members) {
        const kid = kids.get(child);
        if (kid !== undefined) {
            records.set(child, kid);
        }
    }
    return { heads, members, records };
};

// How a member stands as the cancel runs: off its record where this daemon supervises it, else off its conversation.
const standingOf = (deps: ChildCancelDeps, family: Family, child: string): ChildStanding => {
    const kid = family.records.get(child) ?? deps.conversations.holdings(CHILDREN).get(child);
    if (kid !== undefined) {
        return { tracked: true, heldForOwner: kid.held !== undefined, paused: kid.paused !== undefined, running: kid.running };
    }
    const run = liveRunOf(deps.conversations, child);
    const held = deps.conversations.state(child)?.resume.held;
    return {
        tracked: false,
        sandboxRun: run !== undefined && deps.conversations.holdings(PERSON_RUNS).get(child) !== run.id,
        bookedRerun: held !== undefined && !held.fired && held.input.speaker?.kind !== "person",
    };
};

// Stops one member as its move says: the cancel tool's own path, or its live turn and its booking directly.
const stopMember = async (deps: ChildCancelDeps, family: Family, { child, move }: FamilyCancel): Promise<void> => {
    if (move.kind === "cancel") {
        const kid = family.records.get(child) ?? deps.conversations.holdings(CHILDREN).get(child);
        if (kid !== undefined) {
            await cancelRecord(deps, child, kid);
        }
        return;
    }
    if (move.drop) {
        deps.conversations.send(child, { kind: "resume-dropped" });
    }
    const run = move.stop ? liveRunOf(deps.conversations, child) : undefined;
    if (run !== undefined) {
        await deps.turns.stop({ conversationId: child, run: run.id });
    }
};

/**
 * Cancels the family below conversations leaving the board (family-cancel.ts): every running turn, waiting start and
 * booked re-run of the children they spawned, and of theirs, as each one's parent would cancel it. Their conversations and
 * what they wrote stay. Run once the heads are filed away or forgotten, so a stopped child's ending is said to nobody and
 * its work lands as any conversation's does, never into a checkout on its way out; a child with children of its own is
 * marked first, so the endings stopped under it do not wake it into a turn. The children stop side by side, since a stop
 * waits for its turn to unwind. Never throws; answers what it cancelled.
 */
export const cancelFamily = async (deps: FamilyDeps, family: Family, why: FamilyEnd): Promise<readonly FamilyCancel[]> => {
    if (family.members.length === 0) {
        return [];
    }
    const cancels = familyCancels(family.members, (child) => standingOf(deps, family, child));
    const heads = new Set(family.heads);
    for (const { parent } of cancels) {
        if (!heads.has(parent)) {
            markFamilyEnded(deps.conversations, parent, Date.now());
        }
    }
    const stopped = await Promise.all(
        cancels.map(async (cancel) => {
            try {
                await stopMember(deps, family, cancel);
                return [cancel];
            } catch (error) {
                deps.logger.warn(
                    { err: error, child: cancel.child, parent: cancel.parent, why },
                    "subagents: a child of a conversation that left could not be cancelled",
                );
                return [];
            }
        }),
    );
    const done = stopped.flat();
    if (done.length > 0) {
        deps.logger.info(
            { why, heads: family.heads, cancelled: done.map(({ child, parent, move }) => ({ child, parent, ...move })) },
            "subagents: cancelled the children of conversations that left the board",
        );
    }
    return done;
};

// Everything a parent may do about its children, as one object shared by every door (tool mounts, CLI arm).
export interface ChildSupervisor {
    readonly spawn: (spec: ChildSpawnSpec) => Promise<ChildSpawnResult>;
    // Read at call time, never snapshotted: an allowance can empty while a turn runs.
    readonly providers: () => Promise<readonly SpawnableProvider[]>;
    // `rehome` moves a settled or paused child onto another provider and model for this turn, in its own worktree.
    readonly send: (childId: string, message: string, rehome?: ChildRehome) => Promise<ChildActionResult>;
    readonly answer: (childId: string, answers: Record<string, string[]>) => Promise<ChildActionResult>;
    readonly pendingQuestion: (childId: string) => PendingChildCard | undefined;
    // Its last turn's whole closing message, where the roster row cut it.
    readonly report: (childId: string) => string | undefined;
    // Where its work went: into the parent's own checkout, or held off it by a clash (child-lands.ts).
    readonly landing: (childId: string) => string | undefined;
    // Brings a child's work held off the parent's checkout by a clash into it with conflict markers to resolve.
    readonly merge: (childId: string) => Promise<ChildActionResult>;
    // Stops a child's running turn, its pending start, or the re-run the sandbox booked for it.
    readonly cancel: (childId: string) => Promise<ChildActionResult>;
    // Parks until one of the parent's children or background commands moves, or the named one does.
    readonly wait: (options: SubagentWaitOptions) => Promise<WorkWaitOutcome>;
    // Hands a task to another of the owner's sandboxes over a link card (links/linked-children.ts): a `linked` child,
    // reached by the calls above like any other, whose work runs and lands over there.
    readonly delegate: (ask: DelegateAsk) => Promise<ChildSpawnResult>;
    // The linked sandboxes this turn may hand work to, and whether each answers right now.
    readonly links: () => Promise<readonly LinkListing[]>;
}

export const childSupervisor = (services: Services, parent: ChildParent): ChildSupervisor => {
    const linked = services.linkedChildren;
    const ownChild = (childId: string): boolean => services.conversations.holdings(CHILDREN).get(childId)?.parent === parent.conversationId;
    return {
        spawn: (spec) => spawnChild(services, parent, spec),
        providers: () => spawnableProviders(services),
        send: (childId, message, rehome) => {
            if (!linked.owns(childId)) {
                return sendToChild(services, parent, childId, message, rehome);
            }
            return rehome === undefined ? linked.send(parent, childId, message) : Promise.resolve(LINKED_REHOME);
        },
        answer: (childId, answers) =>
            linked.owns(childId) ? linked.answer(parent, childId, answers) : answerChild(services, parent, childId, answers),
        pendingQuestion: (childId) => {
            if (linked.owns(childId)) {
                return linked.pendingQuestion(childId);
            }
            return ownChild(childId) ? pendingQuestionOf(services.conversations, childId) : undefined;
        },
        report: (childId) => {
            if (linked.owns(childId)) {
                return linked.report(childId);
            }
            return ownChild(childId) ? childReportOf(services.conversations, childId) : undefined;
        },
        landing: (childId) => {
            if (linked.owns(childId)) {
                return linked.landing(childId);
            }
            return ownChild(childId) ? childLandingWords(services.agents, childId) : undefined;
        },
        merge: (childId) => (linked.owns(childId) ? Promise.resolve(LINKED_MERGE) : mergeChild(services, parent, childId)),
        cancel: (childId) => (linked.owns(childId) ? linked.cancel(parent, childId) : cancelChild(services, parent, childId)),
        wait: (options) => waitForWork(services.conversations, parent.conversationId, options),
        delegate: (ask) => linked.delegate(parent, ask),
        links: () => linked.links(parent.conversationId),
    };
};
