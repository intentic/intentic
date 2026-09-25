import {
    type AgentEvent,
    type AgentReply,
    type ModelPin,
    type AgentTurn,
    type ParkedRequest,
    breakArmed,
    profileOf,
    RESUME_NOTES,
    type ResumeReason,
    type ResumeRouting,
    RETRY_LADDER_TRIES,
    retryLadderDelay,
    type TodoItem,
    type TurnBreak,
    type TurnBreakPolicy,
    withoutResumeNote,
    withResumeNote,
} from "@intentic/sandbox-contract";
import { replaceRejectedToken } from "../../../runtimes/claude/claude-credentials.js";
import type { Services } from "../../../composition.js";
import { openingRows, openTurnTranscript, recordInterruptedTurn, recordTurnTranscript } from "../../../sessions/turn-transcript.js";
import { POST_PLAN_MODE } from "../agent.js";
import { formatAnswers } from "../../tools/question-answers.js";
import { personaRunModel, runRoleModel } from "../../models/run-role-model.js";
import { outageRetryDue, outageRetryFired } from "../../providers/provider-health.js";
import { consumeEntry, type JournalEntry, type JournalledTurn, resumeBars, spendAttempt } from "./turn-journal.js";
import type { SentTurn, StartedRun, StartOptions, TurnInput, TurnStarter } from "../../../seams/turn-starter.js";
import { refusedBegin } from "../conversation/turn-placement.js";
import { startTurnRun, type TurnRun } from "./turn-runs.js";
import type { BeginRefusal } from "../../../agents/actor/conversation-decide.js";
import type { HeldRecord } from "../../../agents/actor/conversation-state.js";
import { opt } from "../../../opt.js";
import type { VerificationStanding } from "../../verification/agent-verification.js";

// Re-runs a turn once its blocker clears. Two kinds live here and should not be confused: the daemon's own bookkeeping
// (a rotated token, a restart, a session past its window), which needs nobody's permission, and the three walls the
// reader answers for — a spent allowance, a provider outage, a turn that stopped short — each of which fires only on
// that conversation's own policy (turn-break.ts), because a re-run spends the reader's budget on a turn they sent once.
// What is pending lives in each conversation's actor; a new turn on the conversation supersedes it.

// The wall a held turn stopped at; `stopped` is a death with nothing to repair, `door` a refusal before the model saw it.
export type HeldReason = "limit" | "stopped" | "overflow" | "door" | "outage" | "auth";

// A turn a wall stranded, held for a press (however long it takes) or the resume pass (RUNGS).
export interface HeldTurn {
    readonly input: TurnInput & { conversationId: string };
    readonly reason: HeldReason;
    // The run a door refusal ended, whose recorded rows are no history: the model never saw them.
    readonly run?: string;
    // The session the failed turn last reported; kept even when unused, so the fire can decide via `ran`.
    readonly sessionId?: string;
    // Epoch seconds the allowance reopens. Absent (Grok, Cursor publish none) means press-only, never guessed.
    readonly reopensAt?: number;
    // Whether the provider answered before the wall; false makes its session unsafe to reuse.
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
    // An auth hold's credential: the account to re-mint, and the refused token the rotation must supersede, not replay.
    readonly remint?: { readonly account: string; readonly refusedToken: string } | undefined;
}

// Whether the press keeps the held turn's runtime. Absent fields default to the wire's claude/native, so spelling them
// out isn't a switch.
const sameRuntime = (input: AgentTurn, routing: ResumeRouting): boolean =>
    routing.agent === (input.agent ?? "claude") && routing.harness === (input.harness ?? "native");

// The account a press runs on. Naming none on the same runtime keeps the held turn's: only a person's explicit pick
// moves a conversation to another account, and a press that names nothing chose nothing. On another runtime the held
// account belongs to the one being left, so nothing carries over.
const pressedAccount = (input: AgentTurn, routing: ResumeRouting): string | undefined =>
    routing.account ?? (sameRuntime(input, routing) ? input.account : undefined);

// The turn's own fields come from the held copy; routing (agent/harness/account/model) comes from the press when named.
// Destructure-then-add so a press onto another runtime leaves none of the old runtime's fields standing.
const reroutedInput = (input: TurnInput & { conversationId: string }, routing: ResumeRouting | undefined): TurnInput & { conversationId: string } => {
    if (routing === undefined) {
        return input;
    }
    const { agent: _agent, harness: _harness, account: _account, model: _model, ...rest } = input;
    // No model in the press keeps the refused turn's; an unloaded catalog has no pick to send.
    const model = routing.model ?? input.model;
    const account = pressedAccount(input, routing);
    return {
        ...rest,
        agent: routing.agent,
        harness: routing.harness,
        ...(account !== undefined ? { account } : {}),
        ...(model !== undefined ? { model } : {}),
    };
};

// Retires the session on an agent/harness change (not a model swap) unless `carry` covers an account change too.
const retiresSession = (input: AgentTurn, routing: ResumeRouting | undefined): boolean =>
    routing !== undefined && (!sameRuntime(input, routing) || (pressedAccount(input, routing) !== input.account && routing.carry !== true));

// Same runtime, different account: the case the `carried` note describes.
const movesAccount = (input: AgentTurn, routing: ResumeRouting | undefined): boolean =>
    routing !== undefined && sameRuntime(input, routing) && pressedAccount(input, routing) !== input.account;

// A re-run's note, whether it opens fresh, and whether it replaces an earlier attempt's note rather than keeping it.
interface RerunNote {
    readonly reason: ResumeReason;
    readonly fresh?: true;
    readonly restate?: true;
}

// Keeps the session when the turn ran and nothing retires it; fresh otherwise, `switched` if it ran and `refused` if not.
const wallNote = (held: HeldTurn, routing: ResumeRouting | undefined): RerunNote => {
    if (held.ran && held.carryRefused !== true && !retiresSession(held.input, routing)) {
        return { reason: held.reason === "stopped" ? "stopped" : movesAccount(held.input, routing) ? "carried" : "limit", restate: true };
    }
    if (held.reason === "stopped") {
        return { reason: "stopped", fresh: true, restate: true };
    }
    return { reason: held.ran ? "switched" : "refused", fresh: true, restate: true };
};

const rerunNote = (held: HeldTurn, routing: ResumeRouting | undefined): RerunNote => {
    switch (held.reason) {
        case "auth":
        case "outage":
            return { reason: held.reason };
        // Its own session never saw it, and stays unless the press moved runtimes.
        case "door":
            return retiresSession(held.input, routing) ? { reason: "door", fresh: true } : { reason: "door" };
        // The one wall whose own session is the obstacle: fresh whatever ran, with the hand-off the record seeds.
        case "overflow":
            return { reason: "overflow", fresh: true, restate: true };
        default:
            return wallNote(held, routing);
    }
};

// A held turn sent again where `routing` points, by whoever sends it now; a door refusal's run joins those whose rows the
// model never saw.
const rerunOf = (held: HeldTurn, byPerson: boolean, routing?: ResumeRouting): SentTurn & { conversationId: string } => {
    const turn = { ...resumedTurn({ input: reroutedInput(held.input, routing), sessionId: held.sessionId }, rerunNote(held, routing)), byPerson };
    return held.run === undefined ? turn : { ...turn, unseenRuns: [...(held.input.unseenRuns ?? []), held.run] };
};

// Undefined when nothing a press answers for is held (an outage or a refused credential is the pass's), a turn runs, or
// the conversation is archived and no person pressed.
export const fireHeldResume = async (
    services: Pick<Services, "conversations" | "turns">,
    conversationId: string,
    byPerson: boolean,
    routing?: ResumeRouting,
): Promise<StartedRun | undefined> => {
    const held = services.conversations.state(conversationId)?.resume.held;
    if (held === undefined || held.reason === "auth" || held.reason === "outage") {
        return undefined;
    }
    const started = await services.turns.start(rerunOf(held, byPerson, routing));
    return typeof started === "string" ? undefined : started;
};

// The one reader for every ending's question. Two callers must agree about the same turn — the failure frame promises
// what happens next, and the pass below performs it — so both come through here. Per-conversation override wins;
// absent, the sandbox-wide policy answers. Asked fresh at the moment it matters (the window opening, the rung falling
// due), never snapshotted at the failure, so a mind changed in between is honoured; the one exception is the limit's
// move, booked once at the failure (agent.routes) so the request's message and the fire cannot disagree.
export const breakPolicyFor = async (
    services: Pick<Services, "agents" | "sandboxSettings">,
    conversationId: string,
    ending: TurnBreak,
): Promise<TurnBreakPolicy> => {
    const override = services.agents.entry(conversationId)?.postures[ending];
    if (override !== undefined) {
        return override;
    }
    const settings = await services.sandboxSettings.get();
    return ending === "limit" ? settings.limitPolicy : ending === "outage" ? settings.outagePolicy : settings.stopPolicy;
};

// `fresh` drops a session that holds only one unanswered message, for a record-seeded handoff instead of replaying
// provider filler. A note already on the prompt stays unless `restate` replaces it, and `resume` names the one it keeps.
const resumedTurn = (
    failure: { readonly input: TurnInput & { conversationId: string }; readonly sessionId?: string | undefined },
    { reason, fresh, restate }: RerunNote,
): TurnInput & { conversationId: string } => {
    // Destructured out first so `fresh` can unset it, rather than leaving the carried session in place via a spread.
    const { sessionId: carried, ...rest } = failure.input;
    const sessionId = fresh === true ? undefined : (failure.sessionId ?? carried);
    const resume = restate === true ? reason : (failure.input.resume ?? reason);
    return {
        ...rest,
        prompt: withResumeNote(restate === true ? withoutResumeNote(failure.input.prompt) : failure.input.prompt, RESUME_NOTES[resume]),
        resume,
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

// The pin answers for a turn nobody picked a model for, whoever is watching it: `runRole` and `actsAs` are the only
// things that can answer, so an ordinary chat carrying neither is left alone by that alone. Whether anyone is watching
// (`unattended`) is a separate question and not one this pin may read.
const withRoleModel = async <T extends AgentTurn>(services: Services, turn: T): Promise<T> => {
    // Naming either model or agent already answers this: the pin carries a provider with its model, so filling over a
    // chosen agent would move it to a different provider (breaking an intentional cross-provider race).
    if (turn.model !== undefined || turn.agent !== undefined) {
        return turn;
    }
    const pinned =
        (await personaRunModel(services, turn.actsAs)) ?? (turn.runRole === undefined ? undefined : await runRoleModel(services, turn.runRole));
    if (pinned === undefined) {
        return turn;
    }
    // The pin's provider must travel with its model: a model id is only meaningful to the provider that vends it.
    return { ...turn, agent: pinned.provider, model: pinned.model, ...pinnedKnobs(turn, pinned) };
};

// The one path every detached turn starts through, so the announcements and the journal entry live here once, not at
// each call site; `body` is the turn itself. A refusal names why no run was made.
export const startConversationTurn = async (
    services: Services,
    body: TurnStarter["stream"],
    started: SentTurn & { readonly conversationId: string },
    { attempts = 0, senderKeeps = false }: StartOptions = {},
): Promise<TurnRun | BeginRefusal> => {
    const turn = await withRoleModel(services, started);
    const { conversationId, prompt } = turn;
    // The record is copied now; the pump waits for it before invoking the provider.
    const transcriptOpen = openTurnTranscript(services, turn);
    const run = startTurnRun(services, body, turn, {
        journalled: true,
        before: transcriptOpen,
        opening: (startedAt) => openingRows(turn, services.workspace.root, startedAt),
        transcript: (rows, steerRows) => recordTurnTranscript(services, turn, rows, steerRows),
        attempts,
        observer: {
            awaiting: (awaiting) => services.events.publish("turn.awaiting", { conversationId, awaiting }),
            settled: (outcome) => services.events.publish("turn.finished", { conversationId, prompt, outcome }),
        },
        ...(senderKeeps
            ? {}
            : {
                  holdTurnedAway: ({ input, run: turnedAway }) => {
                      services.conversations.send(conversationId, { kind: "turn-held", held: { input, reason: "door", ran: false, run: turnedAway } });
                  },
              }),
    });
    if (run === "archived") {
        services.logger.info({ conversationId, resume: turn.resume }, "turn not started: the conversation is archived, and only a person reopens it");
    }
    return run;
};

export interface TurnResumeScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass; `start` runs it on an interval. Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
}

// The attempt budget spends in under an hour; past this a resume is worse than staying dead.
const OUTAGE_STALE_AFTER_MS = 60 * 60_000;

// How long a request may promise a re-mint before the pass says none is coming.
const AUTH_RESUME_DEADLINE_MS = 60_000;

// Both name the fix (reconnect) rather than the mechanism.
const AUTH_GAVE_UP = "The Claude sign-in this turn ran on could not be renewed in time: reconnect the account, then send again.";
const AUTH_DEAD = "The Claude sign-in this turn ran on could not be renewed: reconnect the account, then send again.";

// A ladder that stops without a word reads as one still climbing, so it says so and names the count it spent.
const STOP_LADDER_GAVE_UP = `This turn was picked back up ${RETRY_LADDER_TRIES} times and got nowhere each time, so nothing more is sent automatically. Send again to carry on.`;

// A spent allowance names an instant to keep; a stopped turn has none, so its rung is measured from when the hold was
// recorded.
const stopRungAt = (recordedAt: number, tries: number): number | undefined => {
    const delay = retryLadderDelay(tries);
    return delay === undefined ? undefined : recordedAt + delay;
};

// When the next rung would fire for a conversation whose ladder has spent `tries`, or undefined once it is spent. Asked
// by the failure frame, which runs a moment before the hold is recorded, so it passes its own `now` as the rung's
// origin and states the very instant the pass will then act on. Keeps every piece of ladder arithmetic in this module.
export const stopResumeAt = (tries: number, now: number = Date.now()): number | undefined => stopRungAt(now, tries);

// The breaker's key is the provider that served the turn: a Claude outage never gates a Codex conversation's resume.
const providerOf = (held: HeldTurn): string => held.input.agent ?? "claude";

// Fire it (re-pointed by a booked move) or give up with the card's words, once `armedBy`'s policy is armed; undefined waits.
type Verdict = { readonly armedBy?: TurnBreak; readonly gaveUp?: string; readonly routing?: ResumeRouting } | undefined;

// When a hold is due or given up, what a landed give-up leaves (dropped, or the ladder stood down), and how it fires.
interface Rung {
    readonly verdict: (held: HeldRecord, now: number) => Verdict;
    readonly spent: "resume-dropped" | "ladder-spent";
    readonly fire: (services: Services, held: HeldRecord, routing: ResumeRouting | undefined, now: number) => Promise<void>;
}

// A held turn's re-run, the sandbox's own, logged once it starts; a refusal names why it did not.
const rerun = async (services: Services, held: HeldTurn, routing?: ResumeRouting): Promise<StartedRun | BeginRefusal> => {
    const started = await services.turns.start(rerunOf(held, false, routing));
    if (typeof started !== "string") {
        const { conversationId } = held.input;
        services.logger.info({ conversationId, reason: held.reason, ...opt("account", routing?.account) }, "held turn re-run fired");
    }
    return started;
};

// The hold's one dispatch, stamped before the start so it holds even if starting conflicts; a ladder rung spends a try.
const dispatch =
    (ladder: boolean): Rung["fire"] =>
    async (services, held, routing) => {
        if (services.conversations.send(held.input.conversationId, { kind: "held-fired", ladder }).reply) {
            await rerun(services, held, routing);
        }
    };

// `retry` keeps the hold: a throw never asked the question, and a turn still unwinding cannot yet be told the answer.
const remintAndRerun = async (services: Services, held: HeldTurn): Promise<"done" | "retry"> => {
    const { remint } = held;
    if (remint === undefined) {
        return "done";
    }
    let replacement: string | undefined;
    try {
        replacement = await replaceRejectedToken(services.claudeStore, remint.account, remint.refusedToken);
    } catch (error) {
        services.logger.warn({ err: error, account: remint.account }, "auth auto-resume could not re-mint the refused token");
        return "retry";
    }
    // Nothing new to run: the credential is revoked, or re-mint handed back the very token that was just refused.
    if (replacement === undefined || replacement === remint.refusedToken) {
        const settled = await services.conversations.send(held.input.conversationId, { kind: "resume-abandoned", reason: AUTH_DEAD }).settled;
        return settled ? "done" : "retry";
    }
    return (await rerun(services, held)) === "busy" ? "retry" : "done";
};

// One re-mint in flight per conversation, so a slow one isn't refired by the next pass underneath itself.
const fireAuthResume: Rung["fire"] = async (services, held) => {
    const { conversationId } = held.input;
    if (services.conversations.state(conversationId)?.resume.authFiring === true) {
        return;
    }
    services.conversations.send(conversationId, { kind: "auth-firing", firing: true });
    try {
        if ((await remintAndRerun(services, held)) !== "retry") {
            services.conversations.send(conversationId, { kind: "resume-dropped" });
        }
    } finally {
        services.conversations.send(conversationId, { kind: "auth-firing", firing: false });
    }
};

// A door hold has no rung: whether a turn goes past the wall that stopped it is a person's call, not a clock's.
const RUNGS: { readonly [R in HeldReason]?: Rung } = {
    // On no policy; the deadline comes before the in-flight gate, since a wedged attempt is exactly what it must catch.
    auth: {
        verdict: (held, now) => (now - held.recordedAt > AUTH_RESUME_DEADLINE_MS ? { gaveUp: AUTH_GAVE_UP } : {}),
        spent: "resume-dropped",
        fire: fireAuthResume,
    },
    // Offered to the shared breaker oldest first: firing moves its clock, so the rest on the same provider wait.
    outage: {
        verdict: (held, now) => {
            if (now - held.recordedAt > OUTAGE_STALE_AFTER_MS) {
                return {
                    gaveUp: `${providerOf(held)} was down when this turn ran and the hour it had to come back has passed: send again to pick it up.`,
                };
            }
            return outageRetryDue(providerOf(held), now) ? { armedBy: "outage" } : undefined;
        },
        spent: "resume-dropped",
        // Counted and dropped at dispatch, so the breaker's window closes even if starting conflicts.
        fire: async (services, held, _routing, now) => {
            outageRetryFired(providerOf(held), now);
            services.conversations.send(held.input.conversationId, { kind: "resume-dropped" });
            await rerun(services, held);
        },
    },
    // A bounded ladder, since it fires repeatedly: spent, it stands down and says so, leaving the hold for a press.
    stopped: {
        verdict: (held, now) => {
            const dueAt = stopRungAt(held.recordedAt, held.tries);
            if (dueAt === undefined) {
                return { armedBy: "stopped", gaveUp: STOP_LADDER_GAVE_UP };
            }
            return dueAt <= now ? { armedBy: "stopped" } : undefined;
        },
        spent: "ladder-spent",
        fire: dispatch(true),
    },
    // The daemon's own remedy, fired at once and on no policy: a press or a clock would only resume the overflowed session.
    overflow: { verdict: () => ({}), spent: "resume-dropped", fire: dispatch(false) },
    // A booked move goes at once; else the reopen instant, never one already past at the refusal (it would loop).
    limit: {
        verdict: (held, now) => {
            if (held.move !== undefined) {
                const { input, move } = held;
                return { routing: { agent: input.agent ?? "claude", harness: input.harness ?? "native", account: move.account, carry: move.carry } };
            }
            const reopensAt = held.reopensAt === undefined ? undefined : held.reopensAt * 1000;
            return reopensAt !== undefined && reopensAt <= now && reopensAt > held.recordedAt ? { armedBy: "limit" } : undefined;
        },
        spent: "resume-dropped",
        fire: dispatch(false),
    },
};

// A given-up hold tells the card first; what it leaves waits until that lands, for a turn still unwinding.
const runRung = async (services: Services, conversationId: string, held: HeldRecord, now: number): Promise<void> => {
    const rung = RUNGS[held.reason];
    const booked = held.fired || rung === undefined ? undefined : rung.verdict(held, now);
    // A move is booked at the failure, but it moves the conversation to another account, so it goes only while the owner
    // still answers the limit with a move: one taken back before this pass waits on its reset like any other hold.
    const withdrawn = booked?.routing !== undefined && (await breakPolicyFor(services, conversationId, "limit")) !== "move";
    const verdict = withdrawn ? rung?.verdict({ ...held, move: undefined }, now) : booked;
    if (verdict === undefined || rung === undefined) {
        return;
    }
    if (verdict.armedBy !== undefined && !breakArmed(await breakPolicyFor(services, conversationId, verdict.armedBy))) {
        return;
    }
    if (verdict.gaveUp === undefined) {
        await rung.fire(services, held, verdict.routing, now);
        return;
    }
    if (await services.conversations.send(conversationId, { kind: "resume-abandoned", reason: verdict.gaveUp }, now).settled) {
        services.conversations.send(conversationId, { kind: rung.spent });
        services.logger.warn({ conversationId, reason: held.reason }, "resume pass gave up the held turn, the request is settled as failed");
    }
};

// One pass over every held turn, oldest first; snapshotted, since every rung stamps or drops the records it walks.
export const createTurnResumeScheduler = (services: Services, intervalMs = 5_000): TurnResumeScheduler => {
    let timer: NodeJS.Timeout | undefined;

    const tick = async (now: number = Date.now()): Promise<void> => {
        for (const { conversationId, record } of services.conversations.stranded()) {
            await runRung(services, conversationId, record, now);
        }
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
    const account = services.agents.entry(conversationId)?.profile.account;
    return account === undefined ? {} : { account };
};

// Restores parked requests verbatim under their original request ids, via a placeholder turn on the ordinary start path.
// The answer's turn starts on the journalled session only after the placeholder fully unwinds and releases the mutex.
const rehydrateParkedTurn = async (services: Services, entry: JournalledTurn): Promise<void> => {
    const conversationId = entry.turn.conversationId;
    const requests = entry.parked ?? [];
    const sessionId = entry.sessionId ?? entry.turn.sessionId;
    // Set before the placeholder returns, read after its run unwinds; a closure since the pump owns the generator.
    let followUp: (AgentTurn & { conversationId: string }) | undefined;
    // Unlike resumedTurn (which repeats the original prompt), this turn's prompt is the user's answer itself.
    const resumed = (answer: string, mode?: AgentTurn["permissionMode"]): TurnInput & { conversationId: string } => ({
        ...entry.turn,
        prompt: withResumeNote(answer, RESUME_NOTES.answered),
        resume: "answered",
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(mode !== undefined ? { permissionMode: mode } : {}),
    });
    // Maps an answered request to the turn that runs next; undefined is the quiet ending live behaviour has too (a
    // dismissed question or a bare permission deny already ends the turn without one).
    const settlementOf = (request: ParkedRequest, reply: AgentReply): (AgentTurn & { conversationId: string }) | undefined => {
        if (request.kind === "plan" && reply.kind === "plan") {
            // Approval runs in POST_PLAN_MODE as a live approval would; rejection returns to plan mode with the
            // feedback.
            return reply.approve
                ? resumed("The user approved the plan: proceed with it.", POST_PLAN_MODE)
                : resumed(reply.feedback?.trim() || "Keep refining the plan, do not exit plan mode yet.", "plan");
        }
        if (request.kind === "question" && reply.kind === "question") {
            return reply.cancelled === true || reply.answers === undefined ? undefined : resumed(formatAnswers(request.questions, reply));
        }
        if (request.kind === "permission" && reply.kind === "permission") {
            if (reply.decision === "deny") {
                const feedback = reply.feedback?.trim() ?? "";
                // Feedback is a redirection the turn takes; a bare deny ends it.
                return feedback === "" ? undefined : resumed(feedback);
            }
            // A one-shot grant, no waiting tool call to feed; `always` still carries the don't-ask-again flavour
            // through.
            services.conversations.send(conversationId, { kind: "grant-restored", tool: request.toolName, always: reply.decision === "always" });
            return resumed(`The user allowed ${request.toolName}: run it and continue where the session left off.`);
        }
        return undefined;
    };
    // Matches what the live raiser registers, so an abort reads identically on either side of a restart.
    const restore = (request: ParkedRequest) => {
        switch (request.kind) {
            case "plan":
                return services.cards.restore(
                    request.requestId,
                    "plan",
                    { kind: "plan", requestId: "", approve: false, feedback: "Planning cancelled." },
                    conversationId,
                );
            case "question":
                return services.cards.restore(request.requestId, "question", { kind: "question", requestId: "", cancelled: true }, conversationId);
            case "permission":
                return services.cards.restore(
                    request.requestId,
                    "permission",
                    { kind: "permission", requestId: "", decision: "deny", feedback: "The turn was cancelled before you answered." },
                    conversationId,
                );
        }
    };
    const placeholder: TurnStarter["stream"] = async function* (input) {
        // Skips the real-turn setup a tool-less placeholder doesn't need (worktree ensure, sync, naming, checkpoint);
        // the resumed turn that follows does all of that at its own start.
        const record = services.agents.entry(conversationId);
        const began = await services.conversations.send(conversationId, {
            kind: "begin",
            turn: {
                conversationId,
                isolated: record?.placement.kind === "worktree",
                prompt: input.prompt,
                profile: profileOf(input),
                byPerson: input.byPerson,
                ...(input.title !== undefined ? { title: input.title } : {}),
                ...(input.origin !== undefined ? { origin: input.origin } : {}),
            },
        }).settled;
        if (began !== "begun") {
            yield* refusedBegin(began);
            return;
        }
        // Every frame folds into the conversation's actor, lighting `awaiting` and the fleet's attention flag.
        const see = (event: AgentEvent): AgentEvent => {
            services.conversations.send(conversationId, { kind: "frame", frame: event });
            return event;
        };
        const controller = new AbortController();
        // Abort freezes every request cancelled, as a live stop does; there is no steering queue here.
        const unregister = services.conversations.registerTurn(conversationId, { abort: () => controller.abort() });
        try {
            // Session frame first, rebinding to the partial work; without it a second restart rehydrates with no
            // session.
            if (sessionId !== undefined) {
                yield see({ kind: "session", sessionId, ...sessionAccount(services, conversationId) });
            }
            // Waiters go up before their frames go out, so a reply racing the replay can't land in the gap and 404.
            const raised = requests.map((request) => ({ request, outcome: restore(request).wait(controller.signal) }));
            for (const { request } of raised) {
                yield see(request);
            }
            const winner = await Promise.race(raised.map(async ({ request, outcome }) => ({ request, ...(await outcome) })));
            // One answer settles the turn; the rest freeze cancelled and the resumed turn re-asks what it still needs.
            controller.abort();
            for (const { outcome } of raised) {
                yield see((await outcome).resolved);
            }
            // A resolved frame with a reply is the user's settlement; without one it's just the abort's stand-in.
            if (winner.resolved.reply !== undefined) {
                followUp = settlementOf(winner.request, winner.reply);
                if (followUp !== undefined) {
                    // Moves the mode as the live gate does, so an attached window's mode chip follows the turn out of
                    // planning.
                    if (winner.request.kind === "plan" && winner.reply.kind === "plan" && winner.reply.approve) {
                        yield see({ kind: "mode", mode: POST_PLAN_MODE });
                    }
                    // Keep the request in Resuming until the resumed turn begins.
                    services.conversations.send(conversationId, { kind: "resume-promised" });
                }
            }
            yield see({ kind: "done" });
        } finally {
            unregister();
            await services.conversations.send(conversationId, { kind: "settle" }).settled;
        }
    };
    // Rehydration spends nothing, and is the sandbox's own; attempts pass through so the journal stays honest about what ran.
    const run = await startConversationTurn(services, placeholder, { ...entry.turn, byPerson: false }, { attempts: entry.attempts });
    if (typeof run === "string") {
        // A live turn already owns the conversation, superseding the park as a hand retry would; or nobody reopened it.
        return;
    }
    services.logger.info({ conversationId, requests: requests.length }, "parked turn rehydrated, its requests are back where they were");
    // Detached: the handoff waits out the whole run, and a request may sit unanswered for days without blocking boot.
    void (async () => {
        await run.waitUntilFinished();
        if (followUp === undefined) {
            return;
        }
        // The answer to a restored card is a person's.
        if (typeof (await services.turns.start({ ...followUp, byPerson: true })) !== "string") {
            services.logger.info({ conversationId }, "parked turn resumed: the user's answer continues its session");
        }
    })().catch((error: unknown) => services.logger.error({ err: error, conversationId }, "parked turn's answer failed to resume it"));
};

// Runs once at boot, before anything else starts a turn on these conversations. Surviving means never settled; each
// entry is consumed (spent or deleted) before it restarts, so a turn that kills the daemon can't loop the boot. An
// automation's interrupted fire is its scheduler's to re-fire (automations/fire-resume.ts).
export const resumeInterruptedTurns = async (services: Services, now: number = Date.now()): Promise<void> => {
    const listed = await services.turnJournal.list().catch((error: unknown): JournalEntry[] => {
        services.logger.warn({ err: error }, "turn journal: unreadable at boot, no interrupted turn is resumed");
        return [];
    });
    const interrupted = listed.filter((entry): entry is JournalledTurn => entry.kind === "turn");
    if (interrupted.length === 0) {
        return;
    }
    const { autoResumeOnRestart } = await services.sandboxSettings.get();
    for (const entry of interrupted) {
        // Skips every gate below: rehydration spends nothing and isn't an attempt, so autoResumeOnRestart, staleness
        // and the attempt cap don't apply. Not cleared here either; the placeholder re-journals it, so a second restart
        // rehydrates again.
        if (entry.parked !== undefined && entry.parked.length > 0) {
            await rehydrateParkedTurn(services, entry).catch((error: unknown) =>
                services.logger.error({ err: error, conversationId: entry.turn.conversationId }, "parked turn failed to rehydrate"),
            );
            continue;
        }
        const { spent, stale } = resumeBars(entry, now);
        if (!autoResumeOnRestart || spent || stale) {
            // Recorded from the provider's own session store before the entry clears, so a failed write keeps the
            // journal instead of losing the turn. Uses the journal's session id, not the registry's, which may still
            // point at the prior turn.
            const recovered = await recordInterruptedTurn(services, entry.turn, entry.sessionId ?? entry.turn.sessionId, entry.startedAt);
            if (!recovered) {
                services.logger.warn(
                    { conversationId: entry.turn.conversationId },
                    "interrupted turn transcript could not be recovered; journal entry was retained",
                );
                continue;
            }
            await consumeEntry(services, entry);
            services.logger.info(
                { entry: entry.kind, spent, stale, autoResumeOnRestart },
                "interrupted turn not resumed: the interruption stands on the record",
            );
            continue;
        }
        // The attempt is spent on disk before the turn restarts; this write has to survive the death it guards against.
        await spendAttempt(services, entry);
        const { conversationId } = entry.turn;
        if (typeof (await services.turns.start(restartTurnOf(entry), { attempts: entry.attempts + 1 })) !== "string") {
            services.logger.info({ conversationId }, "restart auto-resume fired");
        }
    }
};

// Uses resumedTurn's own rules for the prompt and session; the journal just renames the fields a failure record uses.
const restartTurnOf = (entry: JournalledTurn): SentTurn & { conversationId: string } => ({
    ...resumedTurn({ input: entry.turn, sessionId: entry.sessionId }, { reason: "restart" }),
    byPerson: false,
});
