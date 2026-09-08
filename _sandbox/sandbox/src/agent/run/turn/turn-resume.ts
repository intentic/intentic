import {
    type AgentEvent,
    type AgentReply,
    type ModelPin,
    type AgentTurn,
    type ParkedCard,
    RESUME_NOTES,
    type ResumeRouting,
    type TodoItem,
    withoutResumeNote,
    withResumeNote,
} from "@intentic/sandbox-contract";
import { fireAutomation, type WakeFn } from "../../../automations/scheduler.js";
import { replaceRejectedToken } from "../../../runtimes/claude/claude-credentials.js";
import type { Services } from "../../../composition.js";
import { turnAwaiting, turnFinished } from "../../../push/notifications.js";
import { openingRows, openTurnTranscript, recordInterruptedTurn, recordTurnTranscript } from "../../../sessions/turn-transcript.js";
import { grantRestoredPermission, POST_PLAN_MODE } from "../agent.js";
import { formatAnswers } from "../../tools/question-answers.js";
import { restoreRequest } from "../../tools/agent-requests.js";
import { personaRunModel, runRoleModel } from "../../models/run-role-model.js";
import { registerTurn } from "../../anchors/agent-steering.js";
import { outageRetryDue, outageRetryFired } from "../../providers/provider-health.js";
import type { JournalEntry, JournalledTurn } from "./turn-journal.js";
import { startTurnRun, type TurnRun } from "./turn-runs.js";
import type { TurnInput } from "./turn-actor.js";
import type { VerificationStanding } from "../../verification/agent-verification.js";

// Re-runs a turn once its blocker clears: auth (token rotated), provider outage, or a daemon restart; a spent usage
// limit is excluded by default, since it is the user's own budget, not a bug. Keyed by conversationId; a new turn on
// the conversation supersedes any pending resume.

// The attempt budget spends in under an hour; past this a resume is worse than staying dead.
const OUTAGE_STALE_AFTER_MS = 60 * 60_000;

// Covers a rebuild plus a long run, measured from the turn's start since nothing records when the daemon died.
const RESUME_MAX_AGE_MS = 6 * 60 * 60_000;

// Exactly once: written as spent before the resume starts, so the counter survives the crash it guards against.
const MAX_RESUME_ATTEMPTS = 1;

// Bounds how long a card may promise a resume is coming before abandonResume ends the wait.
const AUTH_RESUME_DEADLINE_MS = 60_000;

// Shown when the deadline lapses; names the fix (reconnect) rather than the mechanism.
const AUTH_GAVE_UP = "The Claude sign-in this turn ran on could not be renewed in time: reconnect the account, then send again.";

// Clears all three pending resumes for a conversation; any new turn (a hand retry, a press, the scheduler) supersedes
// them. Includes the held-limit entry: a user typing a new message has declined re-running the old one.
export const clearPendingResume = (conversationId: string): void => {
    pendingAuth.delete(conversationId);
    pendingOutage.delete(conversationId);
    pendingLimit.delete(conversationId);
};

export interface AuthFailure {
    readonly input: AgentTurn & { conversationId: string };
    // The session the failed turn last reported; holds whatever partial work preceded the 401.
    readonly sessionId?: string;
    // account says which credential to re-mint; refusedToken is what the rotation must supersede, not replay.
    readonly account: string;
    readonly refusedToken: string;
}

const pendingAuth = new Map<string, AuthFailure & { readonly recordedAt: number }>();

// Conversations with an attempt in flight, so a slow re-mint isn't refired by the next poll underneath itself.
const firingAuth = new Set<string>();

// False for a turn that is itself an auth resume: a fresh token refused again means the credential is dead, not a
// rotation. Exported so the failure frame can state this before recordAuthFailure runs.
export const authResumable = (prompt: string): boolean => !prompt.startsWith(RESUME_NOTES.auth);

// Recorded from the turn's own exit, not resumed inline, since the failing run still owns the conversation. recordedAt
// starts the AUTH_RESUME_DEADLINE_MS clock.
export const recordAuthFailure = (failure: AuthFailure, now: number = Date.now()): void => {
    if (!authResumable(failure.input.prompt)) {
        return;
    }
    pendingAuth.set(failure.input.conversationId, { ...failure, recordedAt: now });
};

export interface OutageFailure {
    readonly input: AgentTurn & { conversationId: string };
    // The session the failed turn last reported; may hold most of the work for a mid-turn 500.
    readonly sessionId?: string;
    // The breaker's key: a Claude outage never gates a Codex conversation's resume.
    readonly provider: string;
}

const pendingOutage = new Map<string, OutageFailure & { readonly recordedAt: number }>();

// Recorded unconditionally, even for a turn that is itself a resume: unlike auth, a provider still down doesn't mean
// the credential is dead. Recorded regardless of posture, so arming the conversation afterwards still finds it.
export const recordOutageFailure = (failure: OutageFailure, now: number = Date.now()): void => {
    pendingOutage.set(failure.input.conversationId, { ...failure, recordedAt: now });
};

export const pendingOutageFailure = (conversationId: string): OutageFailure | undefined => pendingOutage.get(conversationId);

// A turn a spent allowance stranded, held for a press or, if resumeAfterLimit/moveAfterLimit is set, an automatic fire
// at the reopen instant. No staleness sweep: a press is a deliberate pick-up regardless of how long it's been.
export interface LimitFailure {
    readonly input: AgentTurn & { conversationId: string };
    // The session the failed turn last reported; kept even when unused, so the fire can decide via `ran`.
    readonly sessionId?: string;
    // Epoch seconds the allowance reopens. Absent (Grok, Cursor publish none) means press-only, never guessed.
    readonly reopensAt?: number;
    // Whether the refused turn ran before the allowance stopped it; false makes its session unsafe to reuse.
    readonly ran: boolean;
    // What the turn left behind at death (paths edited, verification, checklist); absent when refused at the door.
    readonly standing?: VerificationStanding | undefined;
    readonly checklist?: readonly TodoItem[] | undefined;
    // Token costs from the failure frame, kept so a reopened tab's record matches the numbers the live frame showed.
    readonly contextTokens?: number | undefined;
    readonly handoffTokens?: number | undefined;
    // Where the owner's policy decided to move this turn, decided once at the failure; the pass only performs it.
    readonly move?: { readonly account: string; readonly carry: boolean } | undefined;
    // Set when the other account refuses the carried session, so the retry opens fresh instead of replaying it.
    readonly carryRefused?: boolean | undefined;
}

// recordedAt and fired are the pass's bookkeeping, kept on the map entry rather than on LimitFailure itself.
const pendingLimit = new Map<string, LimitFailure & { readonly recordedAt: number; readonly fired: boolean }>();

// Recorded from the turn's exit, like its neighbours. Unconditional even for a turn that is itself a resume, since an
// allowance refusing twice is ordinary, not hopeless, and regardless of posture, so arming afterwards still finds it.
export const recordLimitFailure = (failure: LimitFailure, now: number = Date.now()): void => {
    pendingLimit.set(failure.input.conversationId, { ...failure, recordedAt: now, fired: false });
};

/** Whether a press on this conversation has a held turn to re-run. */
export const pendingLimitFailure = (conversationId: string): LimitFailure | undefined => pendingLimit.get(conversationId);

// The turn's own fields come from the held copy; routing (agent/harness/account/model) comes from the press when named.
// Destructure-then-add so a press can unset a field instead of leaving the old value standing.
const reroutedInput = (input: AgentTurn & { conversationId: string }, routing: ResumeRouting | undefined): AgentTurn & { conversationId: string } => {
    if (routing === undefined) {
        return input;
    }
    const { agent: _agent, harness: _harness, account: _account, model: _model, ...rest } = input;
    // No model in the press keeps the refused turn's; an unloaded catalog has no pick to send.
    const model = routing.model ?? input.model;
    return {
        ...rest,
        agent: routing.agent,
        harness: routing.harness,
        ...(routing.account !== undefined ? { account: routing.account } : {}),
        ...(model !== undefined ? { model } : {}),
    };
};

// Retires the session on an agent/harness change (not a model swap) unless `carry` covers an account change too. Absent
// fields default to the wire's claude/native, so spelling them out isn't a switch.
const retiresSession = (input: AgentTurn, routing: ResumeRouting | undefined): boolean =>
    routing !== undefined &&
    (routing.agent !== (input.agent ?? "claude") ||
        routing.harness !== (input.harness ?? "native") ||
        (routing.account !== input.account && routing.carry !== true));

// Same runtime, different account: the case the `carried` note describes.
const movesAccount = (input: AgentTurn, routing: ResumeRouting | undefined): boolean =>
    routing !== undefined &&
    routing.agent === (input.agent ?? "claude") &&
    routing.harness === (input.harness ?? "native") &&
    routing.account !== input.account;

// Undefined when nothing is held or a turn already runs (a repeat press is free). Not consumed here: the started turn's
// own clearPendingResume does that, and its exit re-arms it if refused again. `routing` overrides the held turn's own.
export const fireLimitResume = async (
    services: Services,
    wake: WakeFn,
    conversationId: string,
    routing?: ResumeRouting,
): Promise<TurnRun | undefined> => {
    const held = pendingLimit.get(conversationId);
    if (held === undefined) {
        return undefined;
    }
    const failure = { input: reroutedInput(held.input, routing), ...(held.sessionId !== undefined ? { sessionId: held.sessionId } : {}) };
    // restate applies on every arm: the note must describe this attempt's own starting point, not the last one's.
    if (held.ran && held.carryRefused !== true && !retiresSession(held.input, routing)) {
        // Same session either way; the note says only whether the account changed, the one fact the model cannot see.
        const note = movesAccount(held.input, routing) ? RESUME_NOTES.carried : RESUME_NOTES.limit;
        return startConversationTurn(services, wake, resumedTurn(failure, note, { restate: true }));
    }
    // Fresh otherwise: a turn that never ran has a session not worth reusing; one that did is moving without it.
    return startConversationTurn(
        services,
        wake,
        resumedTurn(failure, held.ran ? RESUME_NOTES.switched : RESUME_NOTES.refused, { fresh: true, restate: true }),
    );
};

// Two callers ask this about the same turn and must agree: the failure frame promises a retry, and this pass performs
// it. Per-conversation override wins; absent, the sandbox default answers.
export const outageResumeArmed = async (services: Services, conversationId: string): Promise<boolean> => {
    const override = services.agents.entry(conversationId)?.resumeAfterOutage;
    if (override !== undefined) {
        return override;
    }
    const { resumeAfterOutage } = await services.sandboxSettings.get();
    return resumeAfterOutage;
};

// Same two-level precedence as outageResumeArmed, asked again when the window opens rather than at the failure.
export const limitResumeArmed = async (services: Services, conversationId: string): Promise<boolean> => {
    const override = services.agents.entry(conversationId)?.resumeAfterLimit;
    if (override !== undefined) {
        return override;
    }
    const { resumeAfterLimit } = await services.sandboxSettings.get();
    return resumeAfterLimit;
};

// Same two-level precedence, but asked once at the failure when the move is booked (agent.routes); the pass only
// performs it, so the card's message and the fire can't disagree.
export const moveAfterLimitArmed = async (services: Pick<Services, "agents" | "sandboxSettings">, conversationId: string): Promise<boolean> => {
    const override = services.agents.entry(conversationId)?.moveAfterLimit;
    if (override !== undefined) {
        return override;
    }
    const { moveAfterLimit } = await services.sandboxSettings.get();
    return moveAfterLimit;
};

// `fresh` drops a session that holds only one unanswered message, for a record-seeded handoff instead of replaying
// provider filler. `restate` replaces an existing resume note rather than stacking one, since the reason can change
// between attempts.
const resumedTurn = (
    failure: { readonly input: AgentTurn & { conversationId: string }; readonly sessionId?: string },
    note: string,
    options: { readonly fresh?: boolean; readonly restate?: boolean } = {},
): AgentTurn & { conversationId: string } => {
    // Destructured out first so `fresh` can unset it, rather than leaving the carried session in place via a spread.
    const { sessionId: _carried, ...rest } = failure.input;
    const sessionId = options.fresh === true ? undefined : (failure.sessionId ?? _carried);
    const prompt = options.restate === true ? withoutResumeNote(failure.input.prompt) : failure.input.prompt;
    return {
        ...rest,
        prompt: withResumeNote(prompt, note),
        ...(sessionId === undefined ? {} : { sessionId }),
    };
};

// Resolved once, before journaling, so a restart keeps the model it started on rather than a changed setting. The
// persona's ladder is asked before the role's; if neither answers, the turn keeps no pin.
// Each knob fills only where the turn is silent about it, since these can arrive independently of the model (a surface
// may pin effort but leave the model to the setting). One table, so this list and the settings-row footer agree.
const PIN_KNOBS = ["effort", "thinking", "fast", "harness"] as const;

const pinnedKnobs = (turn: AgentTurn, pin: ModelPin): Partial<AgentTurn> =>
    Object.fromEntries(
        PIN_KNOBS.filter((knob) => turn[knob] === undefined && pin[knob] !== undefined && pin[knob] !== "").map((knob) => [knob, pin[knob]]),
    );

const withRoleModel = async <T extends AgentTurn>(services: Services, turn: T): Promise<T> => {
    // Naming either model or agent already answers this: the pin carries a provider with its model, so filling over a
    // chosen agent would move it to a different provider (breaking an intentional cross-provider race).
    if (turn.unattended !== true || turn.model !== undefined || turn.agent !== undefined) {
        return turn;
    }
    const pinned = (await personaRunModel(services, turn.actsAs)) ?? (turn.runRole === undefined ? undefined : await runRoleModel(services, turn.runRole));
    if (pinned === undefined) {
        return turn;
    }
    // The pin's provider must travel with its model: a model id is only meaningful to the provider that vends it.
    return { ...turn, agent: pinned.provider, model: pinned.model, ...pinnedKnobs(turn, pinned) };
};

// The one path every detached turn starts through, so push notification and the journal entry live here once, not at
// each call site. Undefined means a live turn already owns the conversation; `attempts` is set only by the boot pass.
export const startConversationTurn = async (
    services: Services,
    wake: WakeFn,
    started: TurnInput & { conversationId: string },
    attempts = 0,
): Promise<TurnRun | undefined> => {
    const turn = await withRoleModel(services, started);
    const { conversationId, prompt } = turn;
    // The record is copied now; the pump waits for it before invoking the provider.
    const transcriptOpen = openTurnTranscript(services, turn);
    return startTurnRun((input, signal) => wake(services, input, signal), turn, {
        journal: services.turnJournal,
        before: transcriptOpen,
        opening: (startedAt) => openingRows(turn, services.workspace.root, startedAt),
        transcript: (rows, steerRows) => recordTurnTranscript(services, turn, rows, steerRows),
        attempts,
        observer: {
            awaiting: (kind) => void services.pushSender.notifyIfAway(turnAwaiting(conversationId, kind)),
            settled: (outcome) => void services.pushSender.notifyIfAway(turnFinished(conversationId, prompt, outcome)),
        },
    });
};

export interface TurnResumeScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass; `start` runs it on an interval. Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
}

// What one attempt settled: whether the pending entry is finished with. `retry` exists so an attempt that achieved
// nothing doesn't consume the entry permanently; bounded by AUTH_RESUME_DEADLINE_MS.
type AuthVerdict = "resumed" | "dead" | "retry";

// Re-mints the refused token and re-runs the turn. Adopts a token already rotated elsewhere, refreshing only if the
// store still holds the refused one; a genuinely dead credential returns undefined and the reconnect frame stands.
const fireAuthResume = async (services: Services, wake: WakeFn, failure: AuthFailure): Promise<AuthVerdict> => {
    const conversationId = failure.input.conversationId;
    // A throw isn't an answer: undefined means a known-dead credential; a throw means the question was never asked.
    let replacement: string | undefined;
    try {
        replacement = await replaceRejectedToken(services.claudeStore, failure.account, failure.refusedToken);
    } catch (error) {
        services.logger.warn({ err: error, account: failure.account }, "auth auto-resume could not re-mint the refused token");
        return "retry";
    }
    // Nothing new to run: the credential is revoked, or re-mint handed back the very token that was just refused.
    if (replacement === undefined || replacement === failure.refusedToken) {
        const settled = await services.agents.abandonResume(
            conversationId,
            Date.now(),
            "The Claude sign-in this turn ran on could not be renewed: reconnect the account, then send again.",
        );
        // Still unwinding the very turn this is about; come back next pass once something is left to settle.
        return settled ? "dead" : "retry";
    }
    if ((await startConversationTurn(services, wake, resumedTurn(failure, RESUME_NOTES.auth))) === undefined) {
        // Could be a live turn already owning the conversation; a superseding one clears this via clearPendingResume.
        return "retry";
    }
    services.logger.info({ conversationId, account: failure.account }, "auth auto-resume fired");
    return "resumed";
};

// Every conversation whose credential died, re-minted and re-run, or, past the deadline, told nothing is coming. The
// deadline exists because a silently absent resume looks identical to one about to happen.
const runAuthPass = async (services: Services, wake: WakeFn, now: number): Promise<void> => {
    // Snapshotted before the loop: an await mid-iteration could pick up a failure recorded by a turn still settling.
    const refused = [...pendingAuth.values()];
    for (const failure of refused) {
        const conversationId = failure.input.conversationId;
        if (now - failure.recordedAt > AUTH_RESUME_DEADLINE_MS) {
            // Checked ahead of the in-flight gate: a still-running attempt at the deadline is exactly the wedged case
            // this must catch.
            if (await services.agents.abandonResume(conversationId, now, AUTH_GAVE_UP)) {
                pendingAuth.delete(conversationId);
                services.logger.warn({ conversationId, account: failure.account }, "auth auto-resume gave up, the card is settled as failed");
            }
            continue;
        }
        if (firingAuth.has(conversationId)) {
            continue;
        }
        firingAuth.add(conversationId);
        try {
            if ((await fireAuthResume(services, wake, failure)) !== "retry") {
                pendingAuth.delete(conversationId);
            }
        } finally {
            firingAuth.delete(conversationId);
        }
    }
};

// Offers each stranded conversation to the shared breaker, oldest first; firing moves the breaker's clock, so the rest
// on the same provider are refused within this pass. Posture is read fresh per conversation, not snapshotted at
// failure.
const runOutagePass = async (services: Services, wake: WakeFn, now: number): Promise<void> => {
    const stranded = [...pendingOutage.values()];
    if (stranded.length === 0) {
        return;
    }
    for (const failure of stranded) {
        const conversationId = failure.input.conversationId;
        // Unresumed within the hour means attempts spent or an unanswered toggle; either way the user has moved on.
        if (now - failure.recordedAt > OUTAGE_STALE_AFTER_MS) {
            // Stops the card promising a return; the entry stays until the abandon lands, for a turn still unwinding.
            const settled = await services.agents.abandonResume(
                conversationId,
                now,
                `${failure.provider} was down when this turn ran and the hour it had to come back has passed: send again to pick it up.`,
            );
            if (settled) {
                pendingOutage.delete(conversationId);
            }
            continue;
        }
        // Cheap synchronous breaker check first, posture read second: an unarmed chat costs the armed ones nothing.
        if (!outageRetryDue(failure.provider, now) || !(await outageResumeArmed(services, conversationId))) {
            continue;
        }
        // Counted at dispatch, before the turn starts, so it closes the window even if starting this one conflicts.
        outageRetryFired(failure.provider, now);
        // Dropped before firing: a conflict means a live turn owns it already; a re-failure re-records its own entry.
        pendingOutage.delete(conversationId);
        if ((await startConversationTurn(services, wake, resumedTurn(failure, RESUME_NOTES.outage))) !== undefined) {
            services.logger.info({ conversationId, provider: failure.provider, waiting: stranded.length }, "provider-outage auto-resume fired");
        }
    }
};

// Performs a booked move: re-points the held turn at the policy's account, with or without its session, via the same
// door a press uses.
const fireBookedMove = async (
    services: Services,
    wake: WakeFn,
    input: AgentTurn & { conversationId: string },
    move: NonNullable<LimitFailure["move"]>,
): Promise<void> => {
    const routing: ResumeRouting = { agent: input.agent ?? "claude", harness: input.harness ?? "native", account: move.account, carry: move.carry };
    if ((await fireLimitResume(services, wake, input.conversationId, routing)) !== undefined) {
        services.logger.info(
            { conversationId: input.conversationId, account: move.account, carry: move.carry },
            "usage-limit move fired: the owner's policy moved the held turn to another account",
        );
    }
};

// Fires the held turn at reopen, only when armed: an absent or already-past instant is never scheduled (avoiding an
// infinite loop on a stale one). `fired` marks the one dispatch without deleting the entry, keeping a press idempotent
// after.
const runLimitPass = async (services: Services, wake: WakeFn, now: number): Promise<void> => {
    const stranded = [...pendingLimit.values()];
    for (const held of stranded) {
        const conversationId = held.input.conversationId;
        // A booked move goes first, at once; `fired` is stamped before the start so it holds even if starting
        // conflicts.
        if (!held.fired && held.move !== undefined) {
            pendingLimit.set(conversationId, { ...held, fired: true });
            await fireBookedMove(services, wake, held.input, held.move);
            continue;
        }
        const reopensAt = held.reopensAt;
        if (held.fired || reopensAt === undefined || reopensAt * 1000 > now || reopensAt * 1000 <= held.recordedAt) {
            continue;
        }
        if (!(await limitResumeArmed(services, conversationId))) {
            continue;
        }
        // Stamped before the fire, like the outage pass's dispatch count, so it holds even if the start conflicts.
        pendingLimit.set(conversationId, { ...held, fired: true });
        if ((await fireLimitResume(services, wake, conversationId)) !== undefined) {
            services.logger.info({ conversationId, reopensAt }, "usage-limit auto-resume fired: the allowance window reopened");
        }
    }
};

// Polls all three pending maps. Auth has no gate, it's the daemon's own bookkeeping, not the user's budget; outage
// waits on the shared per-provider breaker; limit is the only one with a real appointment, and the only one that needs
// arming.
export const createTurnResumeScheduler = (services: Services, wake: WakeFn, intervalMs = 5_000): TurnResumeScheduler => {
    let timer: NodeJS.Timeout | undefined;

    const tick = async (now: number = Date.now()): Promise<void> => {
        await runAuthPass(services, wake, now);
        await runOutagePass(services, wake, now);
        await runLimitPass(services, wake, now);
    };

    return {
        tick,
        start: () => {
            timer = setInterval(() => void tick(), intervalMs);
        },
        stop: () => clearInterval(timer),
    };
};

// Reads the registry, not the journalled turn: the registry holds the account that served this conversation; the turn
// itself may carry none. Blank here would let a reattached tab bind its own pick and retire this session.
const sessionAccount = (services: Services, conversationId: string): { account?: string } => {
    const account = services.agents.entry(conversationId)?.account;
    return account === undefined ? {} : { account };
};

// Restores parked cards verbatim under their original request ids, via a placeholder turn on the ordinary start path.
// The answer's turn starts on the journalled session only after the placeholder fully unwinds and releases the mutex.
const rehydrateParkedTurn = async (services: Services, wake: WakeFn, entry: JournalledTurn): Promise<void> => {
    const conversationId = entry.turn.conversationId;
    const cards = entry.parked ?? [];
    const sessionId = entry.sessionId ?? entry.turn.sessionId;
    // Set before the placeholder returns, read after its run unwinds; a closure since the pump owns the generator.
    let followUp: (AgentTurn & { conversationId: string }) | undefined;
    // Unlike resumedTurn (which repeats the original prompt), this turn's prompt is the user's answer itself.
    const resumed = (answer: string, mode?: AgentTurn["permissionMode"]): AgentTurn & { conversationId: string } => ({
        ...entry.turn,
        prompt: withResumeNote(answer, RESUME_NOTES.answered),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(mode !== undefined ? { permissionMode: mode } : {}),
    });
    // Maps an answered card to the turn that runs next; undefined is the quiet ending live behaviour has too (a
    // dismissed question or a bare permission deny already ends the turn without one).
    const settlementOf = (card: ParkedCard, reply: AgentReply): (AgentTurn & { conversationId: string }) | undefined => {
        if (card.kind === "plan" && reply.kind === "plan") {
            // Approval runs in POST_PLAN_MODE as a live approval would; rejection returns to plan mode with the
            // feedback.
            return reply.approve
                ? resumed("The user approved the plan: proceed with it.", POST_PLAN_MODE)
                : resumed(reply.feedback?.trim() || "Keep refining the plan, do not exit plan mode yet.", "plan");
        }
        if (card.kind === "question" && reply.kind === "question") {
            return reply.cancelled === true || reply.answers === undefined ? undefined : resumed(formatAnswers(card.questions, reply));
        }
        if (card.kind === "permission" && reply.kind === "permission") {
            if (reply.decision === "deny") {
                const feedback = reply.feedback?.trim() ?? "";
                // Feedback is a redirection the turn takes; a bare deny ends it.
                return feedback === "" ? undefined : resumed(feedback);
            }
            // A one-shot grant, no waiting tool call to feed; `always` still carries the don't-ask-again flavour
            // through.
            grantRestoredPermission(conversationId, card.toolName, reply.decision === "always");
            return resumed(`The user allowed ${card.toolName}: run it and continue where the session left off.`);
        }
        return undefined;
    };
    // Matches what the live raiser registers, so an abort reads identically on either side of a restart.
    const restore = (card: ParkedCard) => {
        switch (card.kind) {
            case "plan":
                return restoreRequest(
                    card.requestId,
                    "plan",
                    { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." },
                    conversationId,
                );
            case "question":
                return restoreRequest(card.requestId, "question", { kind: "question", requestId: "", cancelled: true }, conversationId);
            case "permission":
                return restoreRequest(
                    card.requestId,
                    "permission",
                    { kind: "permission", requestId: "", decision: "deny", feedback: "The turn was cancelled before you answered." },
                    conversationId,
                );
        }
    };
    const placeholder: WakeFn = async function* (svc, input) {
        // Skips the real-turn setup a tool-less placeholder doesn't need (worktree ensure, sync, naming, checkpoint);
        // the resumed turn that follows does all of that at its own start.
        const record = svc.agents.entry(conversationId);
        const began = await svc.agents.begin(
            {
                conversationId,
                isolated: record?.branch !== undefined,
                prompt: input.prompt,
                provider: input.agent ?? "claude",
                harness: input.harness ?? "native",
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.model !== undefined ? { model: input.model } : {}),
                ...(input.effort !== undefined ? { effort: input.effort } : {}),
                ...(input.thinking !== undefined ? { thinking: input.thinking } : {}),
                ...(input.fast !== undefined ? { fast: input.fast } : {}),
                ...(input.tierHold !== undefined ? { tierHold: input.tierHold } : {}),
                ...(input.account !== undefined ? { account: input.account } : {}),
                ...(input.origin !== undefined ? { origin: input.origin } : {}),
            },
            Date.now(),
        );
        if (!began) {
            yield { kind: "error", code: "agent-busy", message: "This agent is already running a turn, wait for it to finish." };
            yield { kind: "done" };
            return;
        }
        // Every frame folds through registry observe, lighting `awaiting` and the fleet's attention flag.
        const see = (event: AgentEvent): AgentEvent => {
            svc.agents.observe(conversationId, event);
            return event;
        };
        const controller = new AbortController();
        // Abort freezes every card cancelled, as a live stop does; there is no steering queue here.
        const unregister = registerTurn(conversationId, { abort: () => controller.abort() });
        try {
            // Session frame first, rebinding to the partial work; without it a second restart rehydrates with no
            // session.
            if (sessionId !== undefined) {
                yield see({ kind: "session", sessionId, ...sessionAccount(svc, conversationId) });
            }
            // Waiters go up before their frames go out, so a reply racing the replay can't land in the gap and 404.
            const raised = cards.map((card) => ({ card, outcome: restore(card).wait(controller.signal) }));
            for (const { card } of raised) {
                yield see(card);
            }
            const winner = await Promise.race(raised.map(async ({ card, outcome }) => ({ card, ...(await outcome) })));
            // One answer settles the turn; the rest freeze cancelled and the resumed turn re-asks what it still needs.
            controller.abort();
            for (const { outcome } of raised) {
                yield see((await outcome).resolved);
            }
            // A resolved frame with a reply is the user's settlement; without one it's just the abort's stand-in.
            if (winner.resolved.reply !== undefined) {
                followUp = settlementOf(winner.card, winner.reply);
                if (followUp !== undefined) {
                    // Moves the mode as the live gate does, so an attached window's mode chip follows the turn out of
                    // planning.
                    if (winner.card.kind === "plan" && winner.reply.kind === "plan" && winner.reply.approve) {
                        yield see({ kind: "mode", mode: POST_PLAN_MODE });
                    }
                    // Holds the card out of Finished between this turn's end and the resumed turn's begin, which clears
                    // it.
                    svc.agents.markResuming(conversationId);
                }
            }
            yield see({ kind: "done" });
        } finally {
            unregister();
            await svc.agents.finish(conversationId, Date.now());
        }
    };
    // Rehydration spends nothing; attempts pass through unchanged so the journal stays honest about what ran.
    const run = await startConversationTurn(services, placeholder, entry.turn, entry.attempts);
    if (run === undefined) {
        // A live turn already owns the conversation; it supersedes the park, as a hand retry would.
        return;
    }
    services.logger.info({ conversationId, cards: cards.length }, "parked turn rehydrated, its cards are back where they were");
    // Detached: the handoff waits out the whole run, and a card may sit unanswered for days without blocking boot.
    void (async () => {
        await run.waitUntilFinished();
        if (followUp === undefined) {
            return;
        }
        if ((await startConversationTurn(services, wake, followUp)) !== undefined) {
            services.logger.info({ conversationId }, "parked turn resumed: the user's answer continues its session");
        }
    })().catch((error: unknown) => services.logger.error({ err: error, conversationId }, "parked turn's answer failed to resume it"));
};

// Runs once at boot, before anything else starts a turn on these conversations. Surviving means never settled; each
// entry is consumed (spent or deleted) before it restarts, so a turn that kills the daemon can't loop the boot.
export const resumeInterruptedTurns = async (services: Services, wake: WakeFn, now: number = Date.now()): Promise<void> => {
    const interrupted = await services.turnJournal.list().catch((error: unknown) => {
        services.logger.warn({ err: error }, "turn journal: unreadable at boot, nothing is resumed");
        return [];
    });
    if (interrupted.length === 0) {
        return;
    }
    const { autoResumeOnRestart } = await services.sandboxSettings.get();
    for (const entry of interrupted) {
        // Records the interruption even when nothing re-fires; a chat turn needs none, begin() already marked it.
        if (entry.kind === "automation") {
            await services.automations
                .recordRun(entry.automationId, {
                    at: now,
                    outcome: "interrupted",
                    detail: "the sandbox restarted while this run was in flight",
                    conversationId: entry.conversationId,
                })
                .catch((error: unknown) => services.logger.warn({ err: error, automation: entry.automationId }, "interrupted run not recorded"));
        }
        // Skips every gate below: rehydration spends nothing and isn't an attempt, so autoResumeOnRestart, staleness
        // and the attempt cap don't apply. Not cleared here either; the placeholder re-journals it, so a second restart
        // rehydrates again.
        if (entry.kind === "turn" && entry.parked !== undefined && entry.parked.length > 0) {
            await rehydrateParkedTurn(services, wake, entry).catch((error: unknown) =>
                services.logger.error({ err: error, conversationId: entry.turn.conversationId }, "parked turn failed to rehydrate"),
            );
            continue;
        }
        const spent = entry.attempts >= MAX_RESUME_ATTEMPTS;
        const stale = now - entry.startedAt > RESUME_MAX_AGE_MS;
        if (!autoResumeOnRestart || spent || stale) {
            if (entry.kind === "turn") {
                // Recorded from the provider's own session store before the entry clears, so a failed write keeps the
                // journal instead of losing the turn. Uses the journal's session id, not the registry's, which may
                // still point at the prior turn.
                const recovered = await recordInterruptedTurn(services, entry.turn, entry.sessionId ?? entry.turn.sessionId, entry.startedAt);
                if (!recovered) {
                    services.logger.warn(
                        { conversationId: entry.turn.conversationId },
                        "interrupted turn transcript could not be recovered; journal entry was retained",
                    );
                    continue;
                }
            }
            await clearJournalled(services, entry);
            services.logger.info(
                { entry: entry.kind, spent, stale, autoResumeOnRestart },
                "interrupted turn not resumed: the interruption stands on the record",
            );
            continue;
        }
        if (entry.kind === "turn") {
            // The attempt is spent on disk before the turn restarts; this write has to survive the death it guards
            // against.
            await bumpAttempt(services, entry);
            const { conversationId } = entry.turn;
            if ((await startConversationTurn(services, wake, restartTurnOf(entry), entry.attempts + 1)) !== undefined) {
                services.logger.info({ conversationId }, "restart auto-resume fired");
            }
            continue;
        }
        // Re-fires through fireAutomation, the same road an approved wake takes, re-reading the prompt in case it
        // changed. `cleared: "approval"` skips only that gate; the trigger guard still runs.
        const automation = await services.automations.get(entry.automationId);
        if (automation === undefined || !automation.enabled) {
            // Consumed rather than kept: it can never fire, and keeping it would fabricate a second run next boot.
            await clearJournalled(services, entry);
            services.logger.info({ automation: entry.automationId }, "interrupted fire not resumed, the automation is gone or disabled");
            continue;
        }
        await bumpAttempt(services, entry);
        // Detached, must not hold up the boot; fireAutomation writes its own fresh entry over the one just bumped.
        void fireAutomation(services, automation, wake, {
            cleared: "approval",
            attempts: entry.attempts + 1,
            conversationId: entry.conversationId,
            ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
            ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
            ...(entry.title !== undefined ? { title: entry.title } : {}),
        }).catch((error: unknown) => services.logger.error({ err: error, automation: entry.automationId }, "interrupted fire failed to resume"));
        services.logger.info({ automation: entry.automationId }, "restart auto-refire fired");
    }
};

// Uses resumedTurn's own rules for the prompt and session; the journal just renames the fields a failure record uses.
const restartTurnOf = (entry: JournalledTurn): AgentTurn & { conversationId: string } =>
    resumedTurn({ input: entry.turn, ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}) }, RESUME_NOTES.restart);

const clearJournalled = async (services: Services, entry: JournalEntry): Promise<void> => {
    const clear =
        entry.kind === "turn" ? services.turnJournal.clearTurn(entry.turn.conversationId) : services.turnJournal.clearFire(entry.automationId);
    await clear.catch((error: unknown) => services.logger.warn({ err: error }, "turn journal: interrupted entry not cleared"));
};

// A failed write is treated as unspendable: the entry drops, rather than risking a turn that returns on every boot.
const bumpAttempt = async (services: Services, entry: JournalEntry): Promise<void> => {
    const next = { ...entry, attempts: entry.attempts + 1 };
    const write = next.kind === "turn" ? services.turnJournal.recordTurn(next) : services.turnJournal.recordFire(next);
    await write.catch(async (error: unknown) => {
        services.logger.warn({ err: error }, "turn journal: attempt not recorded, dropping the entry rather than risking a resume loop");
        await clearJournalled(services, entry);
    });
};
