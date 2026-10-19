import { within } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { WorkPlace } from "../../workload/resource-budget.js";
import { conversationProfile, isIsolated, worktreeOf } from "../../conversations/registry/agents-store.js";
import { landByHandLeased } from "../../conversations/land/land-by-hand.js";
import { landTargetOf } from "../../conversations/land/land-target.js";
import { parentOfActor } from "../../auth/principal.js";
import type { AgentCapabilities } from "@intentic/sandbox-contract/models/agent-runtimes";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AgentHarness, AgentProvider, TurnProfile } from "@intentic/sandbox-contract/schemas/agent";
import type { AskQuestion, ChildAgentAsk, ChildMove, ChildRun } from "@intentic/sandbox-contract/events/requests";
import type { LimitPolicy } from "@intentic/sandbox-contract/schemas/turn-break";
import { capabilitiesOf } from "@intentic/sandbox-contract/models/agent-catalog";
import { childRunOf } from "@intentic/sandbox-contract/events/child-run";
import { newConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { type Holding, type LiveRun, liveRunOf } from "../../conversations/actor/conversation-holdings.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Services } from "../../composition.js";
import { steerTurn } from "../checkpoints/agent-steering.js";
import { markConversationTaint, RUNTIME_SOURCE } from "../../guard/turn-taint.js";
import { killCauseOf, killNote, runtimeKilled } from "./child-death.js";
import { noteChildWork } from "./child-verification.js";
import { bestRoomFor, type SpawnableProvider, spawnableProviders } from "./spawn-catalog.js";
import {
    blockedMoveReporter,
    markSubagentEndingReported,
    noteSpawnedChild,
    openSpawnedChild,
    ranInProcess,
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
import { endPause, pauseChild } from "./paused-children.js";
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
import { childOpening, childRecordOf, childRouting, movesOn, onceOnly, pendingOf, providerRefusal, rehomeChild, rehomedSpec, repointedNote, sameModel, taskLine, withRun } from "./child-spec.js";
import { BEHIND_MAX_MS, CANCELLED, CANCEL_NOTES, LINKED_MERGE, LINKED_REHOME, NOT_STARTED, START_SUMMARY, carryOnWords, heldAnswer, heldMessage, heldStart, laneHeldNote, movedWords, nowhereToAsk, questionWords, quoted, startedWhy } from "./child-words.js";
import { elsewhereFor, namedPaths, spentAsked } from "./child-listing.js";
import { seatLine } from "./child-admission.js";
import { resultContract, type ResultSchema, type ResultValue, turnResult } from "./child-result.js";
import { CHILDREN, childResultOf, closeUnstarted, keepChild, SEATS, settleChild } from "./child-records.js";
import { type Admission, admit, askOwner, HELD_MOVES, labelOf, notYet, refusedByRules, restoredStartAnswer, TURN_GRANTS, unanswerableWhy, unmovable } from "./child-gates.js";
import { ROSTER } from "../../conversations/actor/subagent-roster.js";

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
    // refused outright, a model off the plan, a spent allowance with no reset or one past FAR_RERUN_MS, the horizon such a
    // child keeps (childRerunHorizonMs). It moves in
    // its own worktree onto the next one the records do not call spent, and its parent is told.
    readonly fallbacks?: readonly ChildRehome[];
    // The JSON Schema its result must match (child-result.ts): it gets a `result` tool taking that shape, and a wait
    // hands the value over as `result`.
    readonly result?: { readonly schema: ResultSchema };
    // A worker of a workflow run (script-runs.ts): its endings go to the run, which reads them, and never wake its parent
    // as reports of their own.
    readonly run?: { readonly id: string };
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
// `pending` is the escalation ladder's state. Held in memory and written down as it moves (keepChild below,
// spawned-children.ts), so a restart brings back what a parent supervises it by; the rest (a card it is parked on, a
// wait for memory) is this process's and starts afresh.
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
    // held by the fan-out governor until a sibling on its provider is answered or a seat on it frees (`lane`); or its
    // start, waiting for one of its parent's running children to end (`seat`, child-admission.ts).
    held: "start" | "message" | "lane" | "seat" | undefined;
    // Turns of it its parent paid a seat for (its start and every follow-up), which a restart counts back into the
    // parent's lifetime budget.
    turns: number;
    // The accepted start and its order across a restart; a lane hold already reserves one seat.
    startHold?: import("./spawned-children.js").SpawnedChild["startHold"];
    // Writes the current record through its history handle, including cancellations through the narrow cancel port.
    persist?: () => void;
    // The OOM killer's count as its current turn started, so its ending can tell a kill from its own failure.
    oomKillsAtStart: number | undefined;
    // Its last settled turn's whole closing message: what a wait hands over where the roster row's summary cut it.
    report: string | undefined;
    // What its last settled turn handed back against `spec.result`: the value, or why there was none.
    result: { readonly value: ResultValue } | { readonly error: string } | undefined;
    // The value its `result` tool took during the turn under way, which that turn's ending reads (child-result.ts).
    submitted: { readonly value: ResultValue } | undefined;
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

// The run a person started in a spawned child's own chat, held by the child under its own id. A parent leaving stops the
// sandbox's turns on its children and never a person's (cancelFamily), and nothing on a run says who started it.
const PERSON_RUNS: Holding<string> = { name: "person runs in child chats" };
// The supervisor a turn armed for the `/children` routes, which have no tool mount to gate; held under its own id.
const SUPERVISORS: Holding<ChildSupervisor> = { name: "child supervisors" };

// Where a conversation's children, seats and supervisor are held: each conversation's actor.
type Actors = Pick<ConversationActors, "holdings">;

// Starts past their parent's "at once" ceiling, waiting for a seat, oldest first per parent (child-admission.ts).
const SEAT_LINE = seatLine();

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
    SEAT_LINE.reset();
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
            if (kid !== undefined && kid.sessionId !== event.sessionId) {
                kid.sessionId = event.sessionId;
                keepChild(services, childId);
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
    // A start waiting for a seat goes now (child-admission.ts).
    SEAT_LINE.freed(parent);
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
        // A move the owner must allow is theirs to make, not the sandbox's: held counts as no.
        if ((await admit("fallback", { services, parent, spec: target, kid }, childId)).kind !== "proceed") {
            continue;
        }
        giveSeatBack();
        const sent = await moveAndFollow(services, { conversationId: parent, cwd: kid.cwd }, { kid, childId, to: target, message: carryOnWords(from, target, failure) });
        if (sent.ok) {
            void sayToParent(
                services,
                parent,
                `Your subagent \`${childId}\` ("${taskLine(from)}") was refused on ${from.provider}/${from.model} and moved itself to ${kid.spec.provider}/${kid.spec.model}, the next of the fallbacks you gave it: it carries on in the same worktree, and its report comes when that turn ends. The refusal: ${failure}`,
            );
            return true;
        }
        return false;
    }
    return false;
};

// A child's record as its turn ends: nothing running or waiting, its whole closing message as its report, and, for one
// spawned with a result schema, what this turn handed back: its tool's value, else one read off that message. A turn that
// failed or was cancelled hands nothing back. What the tool took stays until the next turn starts, so the report read at
// the run's end reads the same (childTurnResult).
const closeChildTurn = (kid: ChildRecord, whole: string, finished: boolean): void => {
    kid.running = false;
    kid.queued = false;
    kid.pending = undefined;
    kid.cancelled = false;
    kid.report = whole.slice(0, REPORT_WHOLE);
    if (finished) {
        kid.result = turnResult(kid.spec.result?.schema, kid.submitted, whole) ?? kid.result;
    }
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
        closeChildTurn(kid, whole, tally.failure === undefined && !cancelled);
    }
    if (rerun !== undefined && tally.failure !== undefined && error !== undefined && kid !== undefined) {
        pauseChild(services, childId, parent, kid, tally.failure, error);
    } else {
        settleChild(services.conversations, childId, {
            status: cancelled || killed !== undefined ? "killed" : tally.failure !== undefined ? "failed" : "completed",
            report: closing,
            ...opt("error", error),
        });
    }
    giveSeatBack();
    keepChild(services, childId);
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
export const rosterHandle = (services: Services, parent: string): SubagentTurn => ({
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
    followAdopted(services, childId, kid, run);
    void sayToParent(
        services,
        kid.parent,
        `Your subagent \`${childId}\` ("${taskLine(kid.spec)}") is working: ${startedWhy(started)}. Its report reaches you when it ends, like any turn of its: do not send it the task again or give the task to another agent meanwhile.`,
    );
};

// Takes a turn its parent did not start under the parent's supervision: live again, a seat taken, its row reopened (or,
// restored at boot as waiting to see whether its turn resumes, marked working), and its frames followed to their end.
export const followAdopted = (services: Services, childId: string, kid: ChildRecord, run: LiveRun): void => {
    endPause(kid);
    FAN_OUT.adopt(childId, childRouting(kid.spec));
    kid.running = true;
    kid.startedAt = Date.now();
    kid.submitted = undefined;
    const seats = services.conversations.holdings(SEATS);
    const ledger = seats.get(kid.parent) ?? { live: 0, total: 0 };
    seats.hold(kid.parent, kid.parent, { live: ledger.live + 1, total: ledger.total });
    openSpawnedChild(rosterHandle(services, kid.parent), { ...childBirth(childId, kid.spec, kid.depth), again: true });
    // A row restored at boot still says it waits to see whether its turn resumes: this is that turn.
    if (services.conversations.holdings(ROSTER).get(childId)?.status === "pending") {
        noteSpawnedChild(services.conversations, childId, { status: "running", summary: "" });
    }
    keepChild(services, childId);
    void followChildRun(services, childId, kid.parent, kid, run, freshTally());
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
    | { readonly ok: true; readonly release: () => void; readonly limitPolicy: LimitPolicy }
    // `atOnce`: refused only for the "at once" ceiling, which a running child's ending frees, so a start may wait for it.
    | { readonly ok: false; readonly message: string; readonly atOnce?: { readonly live: number; readonly ceiling: number } }
> => {
    const settings = await services.sandboxSettings.get();
    const seats = services.conversations.holdings(SEATS);
    const ledger = seats.get(parent) ?? { live: 0, total: 0 };
    if (ledger.live >= settings.subagentsAtOnce) {
        return {
            ok: false,
            message: `${ledger.live} children are already running: wait for one before starting another.`,
            atOnce: { live: ledger.live, ceiling: settings.subagentsAtOnce },
        };
    }
    if (ledger.total >= settings.subagentsPerTurn) {
        return { ok: false, message: `This conversation has started ${ledger.total} child turns, its lifetime budget.` };
    }
    seats.hold(parent, parent, { live: ledger.live + 1, total: ledger.total + 1 });
    return reservedSeat(services, parent, settings.limitPolicy);
};

// A reservation already counted in SEATS, also used for a lane hold restored at boot.
const reservedSeat = (services: Services, parent: string, limitPolicy: LimitPolicy): Seat => {
    let refunded = false;
    return {
        ok: true,
        limitPolicy,
        release: (): void => {
            if (refunded) {
                return;
            }
            refunded = true;
            refundReservedSeat(services.conversations, parent);
        },
    };
};

// A lane wait that never ran returns both its live reservation and the lifetime turn it had reserved.
const refundReservedSeat = (actors: Actors, parent: string): void => {
    const seats = actors.holdings(SEATS);
    const now = seats.get(parent);
    if (now !== undefined) {
        seats.hold(parent, parent, { live: Math.max(0, now.live - 1), total: Math.max(0, now.total - 1) });
    }
    SEAT_LINE.freed(parent);
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

// A start the gate let through, or held until the owner answers: what was asked, how deep it goes, and the id it runs as.
interface ChildStart {
    readonly asked: ChildSpawnSpec;
    readonly depth: number;
    readonly id: string;
}

// Rebuilding a wait keeps its original ordering token instead of moving it behind newer starts.
const fileHeldStart = (services: Services, parent: ChildParent, start: ChildStart, held: "seat" | "lane" | "start", spec: ChildSpawnSpec): void => {
    const records = services.conversations.holdings(CHILDREN);
    const before = records.get(start.id);
    const kid = childRecordOf(parent, spec, start.depth, held);
    kid.startHold = before?.startHold === undefined ? undefined : { ...before.startHold, kind: held };
    records.hold(parent.conversationId, start.id, kid, start.id);
};

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
    fileHeldStart(services, parent, start, "lane", start.spec);
    openSpawnedChild(rosterHandle(services, parent.conversationId), childBirth(start.id, start.spec, start.depth), true);
    noteSpawnedChild(services.conversations, start.id, { status: "pending", summary: `Held: ${reason}.` });
    keepChild(services, start.id);
    const giveUp = async (why: string): Promise<void> => {
        start.seat.release();
        await abandonChildStart(services, parent.conversationId, start.id, why);
    };
    // Cancelled once off its lane (cancelRecord): ends killed, and its parent, answered already, hears nothing more.
    const cancelled = (): boolean => services.conversations.holdings(CHILDREN).get(start.id)?.cancelled === true;
    FAN_OUT.hold({
        childId: start.id,
        lane,
        // Asked of the records again first: the sibling it waited on may have filed the refusal that makes it pointless.
        start: async () => {
            try {
                const spent = (await spentAsked(services, start.spec)) ?? (cancelled() ? NOT_STARTED.cancelled : undefined);
                const started = spent === undefined ? await startChild(services, parent, start) : { ok: false as const, message: spent };
                if (!started.ok && cancelled()) {
                    start.seat.release();
                    endUnstarted(services, start.id);
                } else if (!started.ok) {
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

// Whether this parent has a seat free among its children right now, as admitChildTurn reads it.
const seatFree = async (services: Services, parent: string): Promise<boolean> =>
    (services.conversations.holdings(SEATS).get(parent)?.live ?? 0) < (await services.sandboxSettings.get()).subagentsAtOnce;

/**
 * A start past its parent's "at once" ceiling, filed as a waiting child so `wait` parks on it and `send` says why it has
 * not started; the seat line starts it, oldest first, when one of its parent's children ends (child-admission.ts). Before
 * this it was refused, and a fan-out wider than the ceiling lost whatever its parent did not think to spawn again.
 */
const waitForSeat = (
    services: Services,
    parent: ChildParent,
    start: GovernedStart,
    full: { readonly live: number; readonly ceiling: number },
): ChildSpawnResult => {
    fileHeldStart(services, parent, start, "seat", start.spec);
    openSpawnedChild(rosterHandle(services, parent.conversationId), childBirth(start.id, start.spec, start.depth), true);
    const reason = `${full.live} of your children are running, the most that may run at once (${full.ceiling}), so it starts by itself when one of them ends`;
    noteSpawnedChild(services.conversations, start.id, { status: "pending", summary: `Waiting for a seat: ${reason}.` });
    keepChild(services, start.id);
    SEAT_LINE.wait(parent.conversationId, {
        childId: start.id,
        start: async () => {
            if (services.conversations.holdings(CHILDREN).get(start.id)?.cancelled === true) {
                endUnstarted(services, start.id);
                return true;
            }
            if (!(await seatFree(services, parent.conversationId))) {
                return false;
            }
            try {
                const started = await startChild(services, parent, { ...start, fromLine: true });
                if (!started.ok) {
                    await abandonChildStart(services, parent.conversationId, start.id, `Not started, and nothing spent on it: ${started.message}`);
                }
            } catch (error) {
                await abandonChildStart(services, parent.conversationId, start.id, errorMessage(error));
            }
            return true;
        },
    });
    return { ok: true, id: start.id, held: true, note: `Waiting for a seat: ${reason}.` };
};

// Starts a child the gate let through: on the owner's pick when they re-pointed it (`repointed`), else as asked. `seat`
// is the one a start the governor held kept while it waited; it is already counted on its lane.
const startChild = async (
    services: Services,
    parent: ChildParent,
    // `fromLine`: a start the seat line released, which goes back to the line rather than joining it again.
    start: GovernedStart & { readonly seat?: Seat; readonly fromLine?: true },
): Promise<ChildSpawnResult> => {
    const { asked, spec, depth, id, repointed } = start;
    if (spec.provider !== asked.provider) {
        const refused = await refusedByRules(services, spec.provider);
        if (refused !== undefined) {
            return { ok: false, message: refused };
        }
    }
    const admitted = start.seat ?? (await admitChildTurn(services, parent.conversationId));
    if (!admitted.ok) {
        return admitted.atOnce !== undefined && start.fromLine === undefined ? waitForSeat(services, parent, start, admitted.atOnce) : admitted;
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
        // A held start its parent cancelled while this was placing it: the fresh record below would wipe the cancel.
        if (start.seat !== undefined && services.conversations.holdings(CHILDREN).get(id)?.cancelled === true) {
            return { ok: false, message: NOT_STARTED.cancelled };
        }
        const record = childRecordOf(parent, spec, depth);
        const turn: TurnInput & { conversationId: string } = {
            prompt: spec.result === undefined ? spec.prompt : `${spec.prompt}\n\n${resultContract(spec.result.schema)}`,
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
        record.turns = (services.conversations.holdings(CHILDREN).get(id)?.turns ?? 0) + 1;
        runChildTurn(services, id, parent.conversationId, turn, placement === undefined ? "local" : { runner: placement });
        handedOff = true;
        keepChild(services, id);
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
const holdChildStart = (services: Services, parent: ChildParent, start: ChildStart, reason: string): void => {
    fileHeldStart(services, parent, start, "start", start.asked);
    openSpawnedChild(rosterHandle(services, parent.conversationId), childBirth(start.id, start.asked, start.depth));
    noteSpawnedChild(services.conversations, start.id, { status: "pending", summary: START_SUMMARY });
    keepChild(services, start.id);
    const kid = services.conversations.holdings(CHILDREN).get(start.id);
    if (kid?.startHold !== undefined) {
        kid.startHold = { ...kid.startHold, reason };
        keepChild(services, start.id);
    }
};

// A held start that will not run: its waiting row ends failed with why, and a parent in its turn is told, unless its wait
// already took the ending.
// A start its parent cancelled before it ran: off the records, its row killed as the cancel's own ending.
const endUnstarted = (services: Pick<ChildCancelDeps, "conversations">, id: string): void => {
    // Settled before the record goes, so a worker's ending is filed as its run's, not its parent's.
    settleChild(services.conversations, id, { status: "killed", report: "", error: CANCELLED });
    closeUnstarted(services.conversations, id);
};

const abandonChildStart = async (services: Services, parent: string, id: string, message: string): Promise<void> => {
    settleChild(services.conversations, id, { status: "failed", report: "", error: message });
    closeUnstarted(services.conversations, id);
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

/** Re-arms an accepted start after boot has adopted the turns that came back and counted their seats. */
export const resumeHeldChild = async (services: Services, id: string, kid: ChildRecord): Promise<void> => {
    const hold = kid.startHold;
    if (hold === undefined || kid.cancelled) {
        return;
    }
    const parent = { conversationId: kid.parent, cwd: kid.cwd };
    const start = { id, depth: kid.depth, asked: kid.spec, spec: kid.spec };
    if (hold.kind === "start") {
        const run = liveRunOf(services.conversations, kid.parent);
        if (run === undefined) {
            await abandonChildStart(services, kid.parent, id, "The sandbox restarted before the owner allowed this start. Its parent's turn did not resume, so there is no live turn on which to raise its approval card. Send the child a message to carry on.");
            return;
        }
        const approval = hold.requestId !== undefined && services.cards.conversationOf(hold.requestId) === kid.parent
            ? restoredStartAnswer(services, kid.parent, run, startAsk(kid.spec), hold.requestId)
            : askOwner(services, kid.parent, run, startAsk(kid.spec), hold.reason ?? "This start still needs the owner's approval.", id);
        void approval.then((admission) => startAllowed(services, parent, start, admission));
        return;
    }
    if (hold.kind === "seat") {
        const settings = await services.sandboxSettings.get();
        waitForSeat(services, parent, start, { live: services.conversations.holdings(SEATS).get(kid.parent)?.live ?? 0, ceiling: settings.subagentsAtOnce });
        SEAT_LINE.freed(kid.parent);
        return;
    }
    const seat = reservedSeat(services, kid.parent, (await services.sandboxSettings.get()).limitPolicy);
    const governed = await governedStart(services, parent, start, seat);
    if (governed === undefined) {
        await startAllowedWithSeat(services, parent, start, seat);
    }
};

// A restored lane reservation is handed to its turn once the governor lets it go, or refunded on every failed exit.
const startAllowedWithSeat = async (services: Services, parent: ChildParent, start: GovernedStart, seat: Seat): Promise<void> => {
    try {
        const started = await startChild(services, parent, { ...start, seat });
        if (!started.ok) {
            seat.release();
            await abandonChildStart(services, parent.conversationId, start.id, started.message);
        }
    } catch (error) {
        seat.release();
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
    const verdict = await admit("spawn", { services, parent: parent.conversationId, spec: asked, depth: { at: depth, most: settings.subagentDepth } });
    if (verdict.kind === "refuse") {
        return { ok: false, message: verdict.message };
    }
    const start: ChildStart = { asked, depth, id: `sub-${newConversationId()}` };
    if (verdict.kind === "proceed") {
        return startChild(services, parent, { ...start, spec: asked });
    }
    const run = liveRunOf(services.conversations, parent.conversationId);
    if (run === undefined) {
        return { ok: false, message: nowhereToAsk(verdict.reason) };
    }
    holdChildStart(services, parent, start, verdict.reason);
    void askOwner(services, parent.conversationId, run, startAsk(asked), verdict.reason, start.id).then((admission) =>
        startAllowed(services, parent, start, admission),
    );
    return { ok: true, id: start.id, held: true, note: heldStart(verdict.reason) };
};

// What every follow-up of a child spawned with a result schema closes with: each turn's result is read afresh.
const RESULT_REMINDER =
    "(Your parent reads a structured result from every turn of yours: when this one is done, call the `result` tool again with the value as it now stands, matching the schema from your task.)";

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
            prompt: kid.spec.result === undefined ? message : `${message}\n\n${RESULT_REMINDER}`,
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
        kid.submitted = undefined;
        kid.turns += 1;
        // A follow-up runs where the conversation already runs: the registry's runner, else here.
        const runner = worktreeOf(services.agents.entry(childId))?.runner;
        runChildTurn(services, childId, parent.conversationId, turn, runner === undefined ? "local" : { runner });
        handedOff = true;
        keepChild(services, childId);
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

/* Moves a child and starts its turn there. One whose turn cannot start (the parent's budgets, a throw) is put back whole:
   left half-moved, its next plain send ran on the new provider with its session forgotten, and the re-run booked where
   it was had already been dropped. That is dropped only once the moved turn is under way. */
const moveAndFollow = async (
    services: Services,
    parent: ChildParent,
    moving: { readonly kid: ChildRecord; readonly childId: string; readonly to: ChildSpawnSpec; readonly message: string },
): Promise<ChildActionResult> => {
    const { kid, childId, to, message } = moving;
    const paused = kid.paused !== undefined;
    const undo = rehomeChild(kid, to);
    let sent: ChildActionResult;
    try {
        sent = await followUp(services, parent, kid, childId, message);
    } catch (error) {
        undo();
        throw error;
    }
    const held = paused && sent.ok ? services.conversations.state(childId)?.resume.held : undefined;
    if (!sent.ok) {
        undo();
    } else if (held !== undefined && !held.fired) {
        services.conversations.send(childId, { kind: "resume-dropped" });
    }
    return sent;
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
        const sent = await moveAndFollow(services, parent, { kid, childId, to: target, message });
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
    const verdict = await admit(target === undefined ? "send" : "rehome", { services, parent: parent.conversationId, spec: target ?? kid.spec, kid }, childId);
    if (verdict.kind === "refuse") {
        return { ok: false, message: verdict.message };
    }
    if (verdict.kind === "proceed") {
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
    const verdict = await admit("answer", { services, parent: parent.conversationId, spec: kid.spec, kid, pending: kid.pending }, childId);
    if (verdict.kind === "refuse") {
        return { ok: false, message: verdict.message };
    }
    if (verdict.kind === "proceed") {
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
    // Held by the governor, not by the owner: the parent may take it back, and it never starts. One already off its lane
    // is being started (holdOnLane), which sees the cancel; refused as "on the owner's card", it started anyway.
    if (kid.held === "lane") {
        const withdrawn = FAN_OUT.withdraw(childId);
        if (!withdrawn && !kid.running) {
            refundReservedSeat(services.conversations, kid.parent);
        }
        if (withdrawn || !kid.running) {
            endUnstarted(services, childId);
        }
        kid.cancelled = true;
        return { ok: true, note: CANCEL_NOTES.waiting };
    }
    // Waiting for a seat among its parent's children: taken off the line, it never starts.
    if (kid.held === "seat") {
        SEAT_LINE.withdraw(kid.parent, childId);
        endUnstarted(services, childId);
        kid.cancelled = true;
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
        settleChild(services.conversations, childId, { status: "killed", report: kid.report ?? "", error: `${failure} ${CANCELLED}` });
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
        // Only a card is the owner's to answer; a start held on its lane or waiting for a seat is the sandbox's to withdraw.
        return { tracked: true, heldForOwner: kid.held === "start" || kid.held === "message", paused: kid.paused !== undefined, running: kid.running };
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
    // What its last settled turn handed back against the schema it was spawned with; undefined without one.
    readonly result: (childId: string) => ChildRecord["result"];
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
        result: (childId) => (linked.owns(childId) || !ownChild(childId) ? undefined : childResultOf(services.conversations, childId)),
        landing: (childId) => {
            if (linked.owns(childId)) {
                return linked.landing(childId);
            }
            return ownChild(childId) ? childLandingWords(services.agents, childId) : undefined;
        },
        merge: (childId) => (linked.owns(childId) ? Promise.resolve(LINKED_MERGE) : mergeChild(services, parent, childId)),
        cancel: async (childId) => {
            if (linked.owns(childId)) {
                return linked.cancel(parent, childId);
            }
            const cancelled = await cancelChild(services, parent, childId);
            keepChild(services, childId);
            return cancelled;
        },
        wait: (options) => waitForWork(services.conversations, parent.conversationId, options),
        delegate: (ask) => linked.delegate(parent, ask),
        links: () => linked.links(parent.conversationId),
    };
};
