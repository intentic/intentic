import { errorMessage } from "@intentic/base/errors";
import type { WorkPlace } from "../../workload/resource-budget.js";
import { worktreeOf } from "../../conversations/registry/agents-store.js";
import type { AgentEvent, AgentHarness, AgentProvider, AskQuestion, ChildAgentAsk, ChildMove, ChildRun, TurnProfile } from "@intentic/sandbox-contract";
import { capabilitiesOf, childRunOf, DEFAULT_HARNESS, newConversationId, PROVIDERS, sameChildRun } from "@intentic/sandbox-contract";
import { cardDeps, raiseRequest } from "../../conversations/actor/card-offers.js";
import type { Holding } from "../../conversations/actor/conversation-holdings.js";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import type { Services } from "../../composition.js";
import { steerTurn } from "../checkpoints/agent-steering.js";
import { childSpawn } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { conversationTaintSource, markConversationTaint } from "../../guard/turn-taint.js";
import { killCauseOf, killNote, runtimeKilled } from "./child-death.js";
import { noteChildWork } from "./child-verification.js";
import { type SpawnableProvider, spawnableProviders } from "./spawn-catalog.js";
import { openSpawnedChild, noteSpawnedChild, settleSpawnedChild, type SubagentTurn, type SubagentWaitOptions } from "./subagents.js";
import { waitForWork, type WorkWaitOutcome } from "./work-wait.js";
import { spokenBy } from "../../seams/turn-speaker.js";
import type { TurnInput } from "../../seams/turn-starter.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { credentialsTravel, placeFanOut } from "../../runners/runner-scheduler.js";
import { runnerSummaries } from "../../runners/runner-peer.js";

// Spawns, steers and answers full agents from inside a turn, on any connected provider; a child is an ordinary
// conversation on the same turn pump, queued until the box has memory for it. A parked question is the parent's to
// answer; a permission or plan hold is the owner's alone. A child outlives its parent's own turn.

/**
 * What a parent is told as its child starts: a box short of memory queues it first, and `wait` covers that too. What
 * the owner changed on the gate's card, when they did, leads, since it is what the parent must not report wrongly.
 */
export const spawnedNote = (id: string, repointed?: string): string =>
    `${repointed === undefined ? "" : `${repointed} `}Started; on a box short of memory it waits as pending until there is room. Supervise it with wait(target: "${id}").`;

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
    // owner changed before allowing it, so the parent's report names the model that actually did the work.
    { readonly ok: true; readonly id: string; readonly note?: string } | { readonly ok: false; readonly message: string };

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
    // The OOM killer's count as its current turn started, so its ending can tell a kill from its own failure.
    oomKillsAtStart: number | undefined;
}

// A spawned child's record, held by its parent and filed about the child, so either one's dispose takes it.
const CHILDREN: Holding<ChildRecord> = { name: "children" };
// A parent's child turns, live and lifetime, held by the parent under its own id.
const SEATS: Holding<{ readonly live: number; readonly total: number }> = { name: "child seats" };
// The supervisor a turn armed for the `/children` routes, which have no tool mount to gate; held under its own id.
const SUPERVISORS: Holding<ChildSupervisor> = { name: "child supervisors" };

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

// Pumps one child turn onto the roster once the box has room for it; shared by spawn and follow-up send. Detached: the
// caller returns with the child queued, and every ending, a refusal included, settles the record and frees its seat.
const runChildTurn = (
    services: Services,
    childId: string,
    parent: string,
    turn: TurnInput & { conversationId: string },
    where: WorkPlace,
): void => {
    void (async () => {
        const kid = services.conversations.holdings(CHILDREN).get(childId);
        let bubble = "";
        let report = "";
        let toolUses = 0;
        let tokens = 0;
        let failure: string | undefined;
        try {
            if (kid !== undefined) {
                kid.queued = true;
            }
            // Admitted here, where the wait can be shown on the child's row, and kept for the door, which takes this
            // admission instead of judging the same turn a second time. A child placed on a runner holds nothing here.
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
            if (room.verdict !== "run") {
                failure = room.message;
                return;
            }
            if (room.waitedMs > 0) {
                noteSpawnedChild(services.conversations, childId, { status: "running", summary: "" });
            }
            if (kid !== undefined) {
                kid.queued = false;
                kid.oomKillsAtStart = (await services.resources.snapshot(0)).reading.oomKills;
            }
            // The parent's agent asked for it, never a person.
            const run = services.turns.run(turn);
            if (run === "busy") {
                failure = "A turn is already running on that conversation.";
                return;
            }
            if (run === "archived") {
                failure = "That child is archived: only a person's message reopens it.";
                return;
            }
            for await (const event of run.frames()) {
                // Normalized frames make this work across providers; a child's own sub-delegations still count as its
                // proof.
                noteChildWork(services.conversations, event, childId);
                if (event.kind === "session") {
                    if (kid !== undefined) {
                        kid.sessionId = event.sessionId;
                    }
                    continue;
                }
                if (event.kind === "delta" && event.parentToolUseId === undefined) {
                    bubble += event.text;
                    continue;
                }
                if (event.kind === "text_end" && event.parentToolUseId === undefined) {
                    // The last closed bubble is the report; earlier text is only a greeting.
                    report = bubble.trim() === "" ? report : bubble;
                    bubble = "";
                    continue;
                }
                if (event.kind === "tool_call" && event.parentToolUseId === undefined) {
                    toolUses += 1;
                    noteSpawnedChild(services.conversations, childId, { toolUses, lastTool: event.name });
                    continue;
                }
                if (event.kind === "usage") {
                    tokens += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
                    noteSpawnedChild(services.conversations, childId, { tokens });
                    continue;
                }
                const parked = pendingOf(event);
                if (parked !== undefined) {
                    if (kid !== undefined) {
                        kid.pending = parked.card;
                    }
                    noteSpawnedChild(services.conversations, childId, { status: "blocked", summary: parked.summary });
                    continue;
                }
                if (event.kind === "resolved") {
                    if (kid !== undefined) {
                        kid.pending = undefined;
                    }
                    noteSpawnedChild(services.conversations, childId, { status: "running" });
                    continue;
                }
                if (event.kind === "error") {
                    failure = event.message;
                }
            }
        } catch (error) {
            failure = errorMessage(error);
        } finally {
            const closing = (bubble.trim() !== "" ? bubble : report).trim().slice(0, REPORT_KEPT);
            // Read while the record still says running, so a `send` cannot start a follow-up this settle then overwrites.
            const killed = failure === undefined ? undefined : await childKillNote(services, childId, failure);
            const error = killed ?? failure;
            if (kid !== undefined) {
                kid.running = false;
                kid.queued = false;
                kid.pending = undefined;
            }
            settleSpawnedChild(services.conversations, childId, {
                status: killed !== undefined ? "killed" : failure !== undefined ? "failed" : "completed",
                report: closing,
                ...(error !== undefined ? { error } : {}),
            });
            const seats = services.conversations.holdings(SEATS);
            const now = seats.get(parent);
            if (now !== undefined) {
                seats.hold(parent, parent, { live: Math.max(0, now.live - 1), total: now.total });
            }
        }
    })();
};

// A supervisor move let through; `run` is set only when the owner re-pointed a start on the card, and is then the whole
// run to start the child on in place of the agent's.
type Admission = { readonly ok: true; readonly run?: ChildRun } | { readonly ok: false; readonly message: string };

// Consulted before every supervisor mutation (spawn, send, answer): the owner's action rules plus the taint floor. A
// hold asks the owner rather than refusing outright, when there is a live turn to ask in.
const admitSupervision = async (services: Services, parent: string, ask: ChildAgentAsk): Promise<Admission> => {
    const settings = await services.sandboxSettings.get();
    const outsideSource = conversationTaintSource(parent);
    const verdict = guard(childSpawn, {
        provider: ask.provider,
        rules: settings.actionRules,
        ...(outsideSource !== undefined ? { outsideSource } : {}),
    });
    if (verdict.effect === "deny") {
        return { ok: false, message: `Refused: ${verdict.reason}.` };
    }
    if (verdict.effect === "hold") {
        return askOwner(services, parent, ask, verdict.reason);
    }
    return { ok: true };
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

// Same window as the payment offer: long enough to return to, short enough not to hold the call open all turn.
const SUPERVISION_DEADLINE_MS = 10 * 60_000;

// What the card quotes of the parent's words to a child: enough to judge it by, not a second transcript.
const MESSAGE_SHOWN = 600;

// Raises the card and waits, or says why it could not be raised. The three refusal messages differ because the model's
// next move differs, and only one is the owner actually declining.
const askOwner = async (services: Services, parent: string, ask: ChildAgentAsk, reason: string): Promise<Admission> => {
    const { move, provider } = ask;
    const run = turnRunOf(services.conversations, parent);
    if (run === undefined || run.done) {
        // No live turn to raise a card in: a detached `agents` shell, or one that already ended.
        return {
            ok: false,
            message:
                `Held for the owner: ${reason}. This call arrived outside a live turn, so there was nowhere to ask them. ` +
                `Ask in chat; they can also set the agents.spawn action rule.`,
        };
    }
    const { decision, reply } = await raiseRequest(
        cardDeps(services),
        { conversationId: parent, push: (event) => run.push(event) },
        {
            kind: "permission",
            onAbort: { kind: "permission", requestId: "", decision: "deny", feedback: "The turn ended before you answered." },
            // No `alwaysLabel`: this call persists no grant, so there is nothing for "always" to remember.
            raised: (requestId) => ({
                kind: "permission",
                requestId,
                toolName: "agents.spawn",
                title: `${MOVE_TITLE[move]} on ${labelOf(provider)}?`,
                displayName: MOVE_BUTTON[move],
                reason,
                child: ask,
            }),
            approves: (answer) => answer.decision !== "deny",
            deadlineMs: SUPERVISION_DEADLINE_MS,
        },
    );
    switch (decision) {
        case "approved": {
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

/**
 * Starts a child agent and returns once it is queued; on a box short of memory it waits as `pending` before its turn
 * runs. Budget/depth refusals come back immediately; a provider refusal surfaces later as the child's own failure.
 */
export const spawnChild = async (services: Services, parent: ChildParent, asked: ChildSpawnSpec): Promise<ChildSpawnResult> => {
    const settings = await services.sandboxSettings.get();
    const depth = spawnDepthOf(services.conversations, parent.conversationId) + 1;
    if (depth > settings.subagentDepth) {
        return { ok: false, message: `Spawn depth ${settings.subagentDepth} reached: this agent is itself a spawned child and may not go deeper.` };
    }
    const description = taskLine(asked);
    const allowed = await admitSupervision(services, parent.conversationId, childAsk("spawn", asked));
    if (!allowed.ok) {
        return allowed;
    }
    // What the owner allowed is what starts: their pick on the card when they changed it, the agent's otherwise.
    const spec = allowed.run === undefined ? asked : withRun(asked, allowed.run);
    if (spec.provider !== asked.provider) {
        const refused = await refusedByRules(services, spec.provider);
        if (refused !== undefined) {
            return { ok: false, message: refused };
        }
    }
    const { provider, harness, model } = childRouting(spec);
    const admitted = await admitChildTurn(services, parent.conversationId);
    if (!admitted.ok) {
        return admitted;
    }
    // Seat is claimed here; every exit must hand it to a running turn or refund it, or the cap drops permanently.
    let handedOff = false;
    try {
        composeRuntimeFloor(parent.conversationId, provider, harness);
        const placement = await childPlacement(services, spec, provider, harness);
        const id = `sub-${newConversationId()}`;
        const profile = childProfile(spec);
        const turn: TurnInput & { conversationId: string } = {
            prompt: spec.prompt,
            conversationId: id,
            title: description.slice(0, 80),
            // Its starter is the parent, which is also how it inherits the parent's owner (agents-registry.ts).
            ...spokenBy({ kind: "agent", conversationId: parent.conversationId }),
            ...(placement !== undefined ? { placement: { kind: "runner" as const, id: placement } } : {}),
            ...profile,
        };
        const children = services.conversations.holdings(CHILDREN);
        children.hold(
            parent.conversationId,
            id,
            {
                // Stores resolved routing, not the raw spec, so a follow-up reaches the same provider and model without
                // drift.
                parent: parent.conversationId,
                spec: { ...spec, provider, harness, model },
                profile,
                depth,
                cwd: parent.cwd,
                sessionId: undefined,
                running: true,
                startedAt: Date.now(),
                pending: undefined,
                queued: false,
                oomKillsAtStart: undefined,
            },
            id,
        );
        // Files under the parent's conversation, what `wait` matches; session/subagentsDir stay empty (SDK children
        // only).
        const handle: SubagentTurn = {
            conversationId: parent.conversationId,
            conversations: services.conversations,
            cwd: parent.cwd,
            sessionId: undefined,
            subagentsDir: undefined,
        };
        openSpawnedChild(handle, {
            id,
            description,
            agentType: labelOf(provider),
            provider,
            harness,
            spawnDepth: depth,
            ...(spec.model !== undefined ? { model: spec.model } : {}),
        });
        runChildTurn(services, id, parent.conversationId, turn, placement === undefined ? "local" : { runner: placement });
        handedOff = true;
        return allowed.run === undefined ? { ok: true, id } : { ok: true, id, note: repointedNote(childRunOf(asked), allowed.run) };
    } finally {
        if (!handedOff) {
            admitted.release();
        }
    }
};

/**
 * Steers a working child, or sends a settled one a follow-up turn resuming its last reported session. Only the parent
 * that started it may reach it.
 */
export const sendToChild = async (services: Services, parent: ChildParent, childId: string, message: string): Promise<ChildActionResult> => {
    const kid = services.conversations.holdings(CHILDREN).get(childId);
    if (kid === undefined || kid.parent !== parent.conversationId) {
        return { ok: false, message: "No such child of this conversation. `list` shows yours." };
    }
    const allowed = await admitSupervision(services, parent.conversationId, askAbout(kid, "send", childId, message));
    if (!allowed.ok) {
        return allowed;
    }
    composeRuntimeFloor(parent.conversationId, kid.spec.provider, childRouting(kid.spec).harness);
    if (kid.queued) {
        return { ok: false, message: "It is waiting for memory and has not started: wait for it, then send again." };
    }
    if (kid.running) {
        // Mid-turn, the only door is the runtime's own steering seam; a runtime without one cannot take words yet.
        return steerTurn(services.conversations, childId, { text: message, voice: "agent" })
            ? { ok: true, note: "Steered: the message lands between its tool calls." }
            : { ok: false, message: "It is mid-turn on a runtime that takes no mid-turn input: wait for it to finish, then send again." };
    }
    const admitted = await admitChildTurn(services, parent.conversationId);
    if (!admitted.ok) {
        return admitted;
    }
    // Seat is claimed; same handoff-or-refund rule as spawnChild covers a throw before the turn starts.
    let handedOff = false;
    try {
        const spec = kid.spec;
        const turn: TurnInput & { conversationId: string } = {
            prompt: message,
            conversationId: childId,
            // Its parent asked, as for the spawn: the settled turn reports back to that parent (child-report.ts).
            ...spokenBy({ kind: "agent", conversationId: parent.conversationId }),
            ...kid.profile,
            // Session from the last turn's report; absent falls back to the ordinary reopened-conversation seed.
            ...(kid.sessionId !== undefined ? { sessionId: kid.sessionId } : {}),
        };
        // Reopens the roster record under the same id with fresh state, so `wait` sees it running again.
        const handle: SubagentTurn = {
            conversationId: parent.conversationId,
            conversations: services.conversations,
            cwd: kid.cwd,
            sessionId: undefined,
            subagentsDir: undefined,
        };
        openSpawnedChild(handle, {
            id: childId,
            description: message.replaceAll(/\s+/gu, " ").trim().slice(0, 200),
            agentType: labelOf(spec.provider),
            provider: spec.provider,
            harness: childRouting(spec).harness,
            spawnDepth: kid.depth,
            ...(spec.model !== undefined ? { model: spec.model } : {}),
        });
        kid.running = true;
        kid.startedAt = Date.now();
        // A follow-up runs where the conversation already runs: the registry's runner, else here.
        const runner = worktreeOf(services.agents.entry(childId))?.runner;
        runChildTurn(services, childId, parent.conversationId, turn, runner === undefined ? "local" : { runner });
        handedOff = true;
        return { ok: true, note: "Sent: the child runs a follow-up turn, once there is memory for it. Supervise it with wait." };
    } finally {
        if (!handedOff) {
            admitted.release();
        }
    }
};

/**
 * Settles a child's question with the parent's picks, and only a question. A permission hold or plan approval is the
 * owner's consent alone; a parent approving those would be a model approving its own actions.
 */
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
    // The picks as the card quotes them: each question with what the parent chose for it.
    const picks = Object.entries(answers)
        .map(([question, chosen]) => `${question} → ${chosen.join(", ")}`)
        .join("\n");
    const allowed = await admitSupervision(services, parent.conversationId, askAbout(kid, "answer", childId, picks));
    if (!allowed.ok) {
        return allowed;
    }
    const pending = kid.pending;
    if (pending === undefined) {
        return { ok: false, message: "It is not waiting on anything right now." };
    }
    if (pending.kind !== "question") {
        return {
            ok: false,
            message:
                pending.kind === "permission"
                    ? "It is waiting on a PERMISSION, which is the owner's consent to give, not a parent's. The owner answers it in their chat."
                    : "It is waiting on PLAN approval, which is the owner's consent to give, not a parent's. The owner answers it in their chat.",
        };
    }
    // Any answer the parent gives is valid; only whether the question still existed comes back.
    if (services.cards.resolve({ kind: "question", requestId: pending.requestId, answers }) !== "settled") {
        return { ok: false, message: "That question already settled." };
    }
    return { ok: true, note: "Answered: the child carries on with your picks." };
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
