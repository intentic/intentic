import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent, AgentHarness, AgentProvider, AgentTurn, AskQuestion } from "@intentic/sandbox-contract";
import { capabilitiesOf, newConversationId, PROVIDERS } from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { createRequest, resolveRequest } from "../tools/agent-requests.js";
import { steerTurn } from "../anchors/agent-steering.js";
import { childSpawn } from "../../guard/actions.js";
import { guard } from "../../guard/guard.js";
import { conversationTaintSource, markConversationTaint } from "../../guard/turn-taint.js";
import { noteChildWork } from "./child-verification.js";
import { type SpawnableProvider, spawnableProviders } from "./spawn-catalog.js";
import { openSpawnedChild, noteSpawnedChild, settleSpawnedChild, type SubagentTurn } from "./subagents.js";
import { startTurnRun, turnRunOf } from "../run/turn/turn-runs.js";
import { openingRows, openTurnTranscript, recordTurnTranscript } from "../../sessions/turn-transcript.js";
import type { TurnFn } from "../../loops/loop-runner.js";
import { credentialsTravel, placeFanOut } from "../../runners/runner-scheduler.js";
import { runnerSummaries } from "../../runners/runner-peer.js";

// Spawns, steers and answers full agents from inside a turn, on any connected provider; a child is an ordinary
// conversation on the same turn pump. A parked question is the parent's to answer; a permission or plan hold is the
// owner's alone. A child outlives its parent's own turn.

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
    // `id` is the child's conversation id: also the roster record's id and the wait tool's target.
    { readonly ok: true; readonly id: string } | { readonly ok: false; readonly message: string };

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
    readonly depth: number;
    readonly cwd: string;
    sessionId: string | undefined;
    running: boolean;
    // When `running` was last set; invariant.ts compares this to tell a not-yet-started record from a stale one.
    startedAt: number;
    pending: PendingChildCard | undefined;
}

const kids = new Map<string, ChildRecord>();

// `depths` keyed by child id (absent = 0); `spent` keyed by parent id: live and lifetime child turn counts.
const depths = new Map<string, number>();
const spent = new Map<string, { live: number; total: number }>();

// Conversations armed to use `/children` routes, which have no tool mount to gate; in-memory, per conversation.
const armed = new Map<string, ChildSupervisor>();

/** Records that this conversation's shell may supervise children; `supervisor` is the exact object a tool call uses. */
export const armSupervisor = (conversationId: string, supervisor: ChildSupervisor): void => {
    armed.set(conversationId, supervisor);
};

/** The armed supervisor for a conversation, or undefined if none was armed. */
export const supervisorFor = (conversationId: string): ChildSupervisor | undefined => armed.get(conversationId);

// Whether this conversation is a spawned child, per the depth ledger (the `sub-` prefix is cosmetic, not
// authoritative). Used to stop anything starting a turn on a child whose report already reached its parent.
export const isSpawnedChild = (conversationId: string): boolean => depths.has(conversationId);

// Every child this daemon knows of, for invariant.ts to cross-check against live turns. Settled children stay listed
// since a follow-up `send` resumes them.
export const childLedger = (): readonly {
    readonly conversationId: string;
    readonly parent: string;
    readonly running: boolean;
    readonly startedAt: number;
}[] => [...kids].map(([conversationId, kid]) => ({ conversationId, parent: kid.parent, running: kid.running, startedAt: kid.startedAt }));

// Clears the child, depth, spend and armed ledgers for a fresh test.
export const resetChildrenForTest = (): void => {
    kids.clear();
    depths.clear();
    spent.clear();
    armed.clear();
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
export const pendingQuestionOf = (childId: string): PendingChildCard | undefined => {
    const pending = kids.get(childId)?.pending;
    return pending?.kind === "question" ? pending : undefined;
};

// Pumps one child turn onto the roster; shared by spawn and follow-up send. Detached: returns once the turn is running,
// and folds a throw into an error frame plus done.
const runChildTurn = (
    services: Services,
    childId: string,
    parent: string,
    turn: AgentTurn & { conversationId: string },
    turnFn: TurnFn,
): { readonly ok: true } | { readonly ok: false; readonly message: string } => {
    const opened = openTurnTranscript(services, turn);
    const run = startTurnRun((input, signal) => turnFn(services, input, signal), turn, {
        before: opened,
        opening: (startedAt) => openingRows(turn, services.workspace.root, startedAt),
        transcript: (rows, steerRows) => recordTurnTranscript(services, turn, rows, steerRows),
    });
    if (run === undefined) {
        return { ok: false, message: "A turn is already running on that conversation." };
    }
    void (async () => {
        const kid = kids.get(childId);
        let bubble = "";
        let report = "";
        let toolUses = 0;
        let tokens = 0;
        let failure: string | undefined;
        try {
            for await (const event of run.frames()) {
                // Normalized frames make this work across providers; a child's own sub-delegations still count as its
                // proof.
                noteChildWork(event, childId);
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
                    noteSpawnedChild(childId, { toolUses, lastTool: event.name });
                    continue;
                }
                if (event.kind === "usage") {
                    tokens += (event.inputTokens ?? 0) + (event.outputTokens ?? 0);
                    noteSpawnedChild(childId, { tokens });
                    continue;
                }
                const parked = pendingOf(event);
                if (parked !== undefined) {
                    if (kid !== undefined) {
                        kid.pending = parked.card;
                    }
                    noteSpawnedChild(childId, { status: "blocked", summary: parked.summary });
                    continue;
                }
                if (event.kind === "resolved") {
                    if (kid !== undefined) {
                        kid.pending = undefined;
                    }
                    noteSpawnedChild(childId, { status: "running" });
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
            if (kid !== undefined) {
                kid.running = false;
                kid.pending = undefined;
            }
            settleSpawnedChild(childId, {
                failed: failure !== undefined,
                report: closing,
                ...(failure !== undefined ? { error: failure } : {}),
            });
            const now = spent.get(parent);
            if (now !== undefined) {
                spent.set(parent, { live: Math.max(0, now.live - 1), total: now.total });
            }
        }
    })();
    return { ok: true };
};

// Consulted before every supervisor mutation (spawn, send, answer): the owner's action rules plus the taint floor. A
// hold asks the owner rather than refusing outright, when there is a live turn to ask in.
const admitSupervision = async (
    services: Services,
    parent: string,
    provider: string,
    move: SupervisionMove,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
    const settings = await services.sandboxSettings.get();
    const outsideSource = conversationTaintSource(parent);
    const verdict = guard(childSpawn, {
        provider,
        rules: settings.actionRules,
        ...(outsideSource !== undefined ? { outsideSource } : {}),
    });
    if (verdict.effect === "deny") {
        return { ok: false, message: `Refused: ${verdict.reason}.` };
    }
    if (verdict.effect === "hold") {
        return askOwner(services, parent, provider, move, verdict.reason);
    }
    return { ok: true };
};

// Which supervisor move is held, so the card names the action truthfully rather than a generic one.
type SupervisionMove = "spawn" | "send" | "answer";
const MOVE_TITLE: Readonly<Record<SupervisionMove, string>> = {
    spawn: "Start a child agent",
    send: "Send this to a child agent",
    answer: "Answer a child agent",
};
const MOVE_BUTTON: Readonly<Record<SupervisionMove, string>> = { spawn: "Start it", send: "Send it", answer: "Answer it" };

// Same window as the payment offer: long enough to return to, short enough not to hold the call open all turn.
const SUPERVISION_DEADLINE_MS = 10 * 60_000;

// Raises the card and waits, or says why it could not be raised. The three refusal messages differ because the model's
// next move differs, and only one is the owner actually declining.
const askOwner = async (
    services: Services,
    parent: string,
    provider: string,
    move: SupervisionMove,
    reason: string,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }> => {
    const run = turnRunOf(parent);
    if (run === undefined || run.done) {
        // No live turn to raise a card in: a detached `agents` shell, or one that already ended.
        return {
            ok: false,
            message:
                `Held for the owner: ${reason}. This call arrived outside a live turn, so there was nowhere to ask them. ` +
                `Ask in chat; they can also set the agents.spawn action rule.`,
        };
    }
    const { id, wait } = createRequest(
        "permission",
        { kind: "permission", requestId: "", decision: "deny", feedback: "The turn ended before you answered." },
        parent,
    );
    // No `alwaysLabel`: this call persists no grant, so there is nothing for "always" to remember.
    const raised: AgentEvent = {
        kind: "permission",
        requestId: id,
        toolName: "agents.spawn",
        title: `${MOVE_TITLE[move]} on ${provider}?`,
        displayName: MOVE_BUTTON[move],
        reason,
    };
    run.push(raised);
    services.agents.observe(parent, raised);
    const { reply, resolved } = await wait(AbortSignal.timeout(SUPERVISION_DEADLINE_MS));
    // Every parked card must get a resolution frame, or the client keeps rendering it as live.
    run.push(resolved);
    services.agents.observe(parent, resolved);
    if (reply.decision === "deny") {
        // A resolved frame with no reply is a timeout or dead client, not a decline; don't treat it as one.
        return resolved.reply === undefined
            ? {
                  ok: false,
                  message: `Nobody answered the request to ${move === "spawn" ? "start" : move} a child agent, so it did not run. Carry on without it and say what you left undone.`,
              }
            : {
                  ok: false,
                  message: `The owner declined this. Do not retry: carry on with what you can do without it, and say plainly what you left undone.`,
              };
    }
    return { ok: true };
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
    const ledger = spent.get(parent) ?? { live: 0, total: 0 };
    if (ledger.live >= settings.subagentsAtOnce) {
        return { ok: false, message: `${ledger.live} children are already running: wait for one before starting another.` };
    }
    if (ledger.total >= settings.subagentsPerTurn) {
        return { ok: false, message: `This conversation has started ${ledger.total} child turns, its lifetime budget.` };
    }
    spent.set(parent, { live: ledger.live + 1, total: ledger.total + 1 });
    return {
        ok: true,
        release: (): void => {
            const now = spent.get(parent);
            if (now !== undefined) {
                spent.set(parent, { live: Math.max(0, now.live - 1), total: Math.max(0, now.total - 1) });
            }
        },
    };
};

// `provider` and `model` are required, with no fallback default. `harness` still defaults to "native" (the provider's
// own loop), which spends no extra allowance and needs no account.
const childRouting = (spec: ChildSpawnSpec): { readonly provider: AgentProvider; readonly harness: AgentHarness; readonly model: string } => ({
    provider: spec.provider,
    harness: spec.harness ?? "native",
    model: spec.model,
});

/**
 * Starts a child agent and returns once it is running. Budget/depth refusals come back immediately; a provider refusal
 * (nothing connected) surfaces later as the child's own failure.
 */
export const spawnChild = async (services: Services, parent: ChildParent, spec: ChildSpawnSpec, turnFn: TurnFn): Promise<ChildSpawnResult> => {
    const settings = await services.sandboxSettings.get();
    const depth = (depths.get(parent.conversationId) ?? 0) + 1;
    if (depth > settings.subagentDepth) {
        return { ok: false, message: `Spawn depth ${settings.subagentDepth} reached: this agent is itself a spawned child and may not go deeper.` };
    }
    const { provider, harness, model } = childRouting(spec);
    const allowed = await admitSupervision(services, parent.conversationId, provider, "spawn");
    if (!allowed.ok) {
        return allowed;
    }
    const admitted = await admitChildTurn(services, parent.conversationId);
    if (!admitted.ok) {
        return admitted;
    }
    // Seat is claimed here; every exit must hand it to a running turn or refund it, or the cap drops permanently.
    let handedOff = false;
    try {
        composeRuntimeFloor(parent.conversationId, provider, harness);
        // No preference: the scheduler places it. A named machine gets it, or here if that machine is unusable.
        const placement =
            spec.on === "here"
                ? undefined
                : placeFanOut(
                      await runnerSummaries(services),
                      { inFlight: services.agents.inFlightByRunner() },
                      {
                          ...(spec.on !== undefined ? { asked: spec.on } : {}),
                          // A credential that cannot travel keeps the child here unless a machine is named explicitly.
                          travels: credentialsTravel(provider, harness),
                      },
                  ).runner;
        const id = `sub-${newConversationId()}`;
        const description = (spec.description ?? spec.prompt).replaceAll(/\s+/gu, " ").trim().slice(0, 200);
        const turn: AgentTurn & { conversationId: string } = {
            prompt: spec.prompt,
            conversationId: id,
            title: description.slice(0, 80),
            // Own worktree, so parallel children and the parent never edit the same files; it lands like any turn's
            // work.
            isolated: true,
            ...(placement !== undefined ? { placement: { kind: "runner" as const, id: placement } } : {}),
            // Nobody is at a composer; this also floors the persona so it speaks for no outside account.
            unattended: true,
            // No `runRole`: the parent's own provider and model pick decides, not a settings-row default.
            agent: provider,
            harness,
            model,
            ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
            ...(spec.account !== undefined ? { account: spec.account } : {}),
        };
        kids.set(id, {
            // Stores resolved routing, not the raw spec, so a follow-up reaches the same provider and model without
            // drift.
            parent: parent.conversationId,
            spec: { ...spec, provider, harness, model },
            depth,
            cwd: parent.cwd,
            sessionId: undefined,
            running: true,
            startedAt: Date.now(),
            pending: undefined,
        });
        // Files under the parent's conversation, what `wait` matches; session/subagentsDir stay empty (SDK children
        // only).
        const handle: SubagentTurn = { conversationId: parent.conversationId, cwd: parent.cwd, sessionId: undefined, subagentsDir: undefined };
        openSpawnedChild(handle, {
            id,
            description,
            agentType: labelOf(provider),
            provider,
            harness,
            spawnDepth: depth,
            ...(spec.model !== undefined ? { model: spec.model } : {}),
        });
        const started = runChildTurn(services, id, parent.conversationId, turn, turnFn);
        if (!started.ok) {
            kids.delete(id);
            settleSpawnedChild(id, { failed: true, report: "", error: started.message });
            // A fresh id colliding with a live run should be impossible; report that rather than pretend the child
            // exists.
            return { ok: false, message: "The child's conversation could not be started." };
        }
        depths.set(id, depth);
        handedOff = true;
        return { ok: true, id };
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
export const sendToChild = async (
    services: Services,
    parent: ChildParent,
    childId: string,
    message: string,
    turnFn: TurnFn,
): Promise<ChildActionResult> => {
    const kid = kids.get(childId);
    if (kid === undefined || kid.parent !== parent.conversationId) {
        return { ok: false, message: "No such child of this conversation. `list` shows yours." };
    }
    const allowed = await admitSupervision(services, parent.conversationId, kid.spec.provider, "send");
    if (!allowed.ok) {
        return allowed;
    }
    composeRuntimeFloor(parent.conversationId, kid.spec.provider, kid.spec.harness ?? "native");
    if (kid.running) {
        // Mid-turn, the only door is the runtime's own steering seam; a runtime without one cannot take words yet.
        return steerTurn(childId, message)
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
        const turn: AgentTurn & { conversationId: string } = {
            prompt: message,
            conversationId: childId,
            isolated: true,
            unattended: true,
            // Reuses the spec's routing verbatim, so a live child never moves onto a different model between turns.
            agent: spec.provider,
            model: spec.model,
            ...(spec.harness !== undefined ? { harness: spec.harness } : {}),
            ...(spec.effort !== undefined ? { effort: spec.effort } : {}),
            ...(spec.account !== undefined ? { account: spec.account } : {}),
            // Session from the last turn's report; absent falls back to the ordinary reopened-conversation seed.
            ...(kid.sessionId !== undefined ? { sessionId: kid.sessionId } : {}),
        };
        // Reopens the roster record under the same id with fresh state, so `wait` sees it running again.
        const handle: SubagentTurn = { conversationId: parent.conversationId, cwd: kid.cwd, sessionId: undefined, subagentsDir: undefined };
        openSpawnedChild(handle, {
            id: childId,
            description: message.replaceAll(/\s+/gu, " ").trim().slice(0, 200),
            agentType: labelOf(spec.provider),
            provider: spec.provider,
            harness: spec.harness ?? "native",
            spawnDepth: kid.depth,
            ...(spec.model !== undefined ? { model: spec.model } : {}),
        });
        kid.running = true;
        kid.startedAt = Date.now();
        const started = runChildTurn(services, childId, parent.conversationId, turn, turnFn);
        if (!started.ok) {
            kid.running = false;
            settleSpawnedChild(childId, { failed: true, report: "", error: started.message });
            return started;
        }
        handedOff = true;
        return { ok: true, note: "Sent: the child is running a follow-up turn. Supervise it with wait." };
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
    const kid = kids.get(childId);
    if (kid === undefined || kid.parent !== parent.conversationId) {
        return { ok: false, message: "No such child of this conversation. `list` shows yours." };
    }
    const allowed = await admitSupervision(services, parent.conversationId, kid.spec.provider, "answer");
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
    if (resolveRequest({ kind: "question", requestId: pending.requestId, answers }) !== "settled") {
        return { ok: false, message: "That question already settled." };
    }
    return { ok: true, note: "Answered: the child carries on with your picks." };
};

// Everything a parent may do about its children, as one object shared by every door (tool mounts, CLI arm). Built by
// the route that owns the turn generator, to avoid a dependency cycle.
export interface ChildSupervisor {
    readonly spawn: (spec: ChildSpawnSpec) => Promise<ChildSpawnResult>;
    // Read at call time, never snapshotted: an allowance can empty while a turn runs.
    readonly providers: () => Promise<readonly SpawnableProvider[]>;
    readonly send: (childId: string, message: string) => Promise<ChildActionResult>;
    readonly answer: (childId: string, answers: Record<string, string[]>) => Promise<ChildActionResult>;
    readonly pendingQuestion: (childId: string) => PendingChildCard | undefined;
}

export const childSupervisor = (services: Services, parent: ChildParent, turnFn: TurnFn): ChildSupervisor => ({
    spawn: (spec) => spawnChild(services, parent, spec, turnFn),
    providers: () => spawnableProviders(services),
    send: (childId, message) => sendToChild(services, parent, childId, message, turnFn),
    answer: (childId, answers) => answerChild(services, parent, childId, answers),
    pendingQuestion: (childId) => (kids.get(childId)?.parent === parent.conversationId ? pendingQuestionOf(childId) : undefined),
});
