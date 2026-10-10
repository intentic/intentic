import {
    type AgentEvent,
    type AgentReply,
    type ModelPin,
    type AgentTurn,
    type ParkedRequest,
    breakArmed,
    cancelledRequests,
    isAwaitingDecision,
    profileOf,
    REQUEST_FIELDS,
    RESUME_NOTES,
    type ResumeReason,
    type ResumeRouting,
    type HandoffMode,
    type HandoffOffer,
    RETRY_LADDER_TRIES,
    retryLadderDelay,
    type TodoItem,
    type TranscriptRow,
    type TurnBreak,
    type TurnBreakPolicy,
    withoutResumeNote,
    withResumeNote,
    withRuntimeDefaults,
} from "@intentic/sandbox-contract";
import { SingleFlight } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import { replaceRejectedToken } from "../../../runtimes/claude/claude-credentials.js";
import { planRevision } from "../../prompt/plan-revision.js";
import type { Services } from "../../../composition.js";
import { openingRows, openTurnTranscript, recordInterruptedTurn, recordTurnTranscript } from "../../../sessions/turn-transcript.js";
import { POST_PLAN_MODE } from "../agent.js";
import { formatAnswers } from "../../tools/question-answers.js";
import { personaRunModel, runRoleModel, unpinnedRunProvider } from "../../models/run-role-model.js";
import { outageRetryDue, outageRetryFired } from "../../providers/provider-health.js";
import { type Routing, routingFor } from "../../providers/accounts/routing.js";
import { consumeEntry, type JournalEntry, type JournalledTurn, parkedRestoreSpent, resumeBars, spendAttempt } from "./turn-journal.js";
import type { StartedRun, StartOptions, TurnInput, TurnStarter } from "../../../seams/turn-starter.js";
import { refusedBegin } from "../placement/turn-placement.js";
import { sessionFor } from "./turn-admission.js";
import { type RunOptions, startTurnRun, type TurnRun } from "./turn-runs.js";
import type { BeginRefusal } from "../../../conversations/actor/conversation-decide.js";
import type { Booked } from "../../../conversations/actor/conversation-actors.js";
import { type Booking, bookingOfItem, waitingOf } from "../../../conversations/actor/conversation-queue.js";
import { type HeldRecord, windowShut } from "../../../conversations/actor/conversation-state.js";
import { versionCommitsSettled } from "../../../conversations/land/version-landed.js";
import { landingRepos, workLanded } from "../../../conversations/land/work-landed.js";
import { opt } from "../../../opt.js";
import type { VerificationStanding } from "../../verification/agent-verification.js";

// Re-runs a turn once its blocker clears. Two kinds live here and should not be confused: the daemon's own bookkeeping
// (a rotated token, a restart, a session past its window), which needs nobody's permission, and the three walls the
// reader answers for — a spent allowance, a provider outage, a turn that stopped short — each of which fires only on
// that conversation's own policy (turn-break.ts), because a re-run spends the reader's budget on a turn they sent once.
// What is pending lives in each conversation's actor; a new turn on the conversation supersedes it.

// The wall a held turn stopped at; `stopped` is a death with nothing to repair, `door` a refusal before the model saw it,
// `flagged` the provider's safety classifier stopping it partway.
export type HeldReason = "limit" | "stopped" | "overflow" | "door" | "outage" | "auth" | "flagged";

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
    // Where a person's pick in the picker re-pointed a limit hold (switchAccount without `run`): not a move, since a pick
    // is never a press, but the account the booked re-run goes on when it fires, at that account's reopen instead.
    readonly onto?: { readonly account: string; readonly carry: boolean } | undefined;
    // Set when the other account refuses the carried session, so the retry opens fresh instead of replaying it.
    readonly carryRefused?: boolean | undefined;
    // The ways a spent allowance's held turn can continue once its cache is cold, measured at the failure, with the one
    // the sandbox suggests and the one a person picked (agent/providers/limit-handoff.ts). Absent: one way on, as before.
    readonly handoff?: HandoffOffer | undefined;
    // An auth hold's credential: the account to re-mint, and the refused token the rotation must supersede, not replay.
    readonly remint?: { readonly account: string; readonly refusedToken: string } | undefined;
    // A flagged hold's session entry before the stopped response (refusal-fork.ts): the re-run resumes there, so the
    // model never reads what the classifier stopped. Absent when the CLI named no such point: a plain resume then.
    readonly resumeAt?: string | undefined;
}

// Where a press sends the held turn, by the one routing rule (agent/providers/accounts/routing.ts), with the held turn's own
// routing as the profile: naming no account keeps the held turn's on its provider, since only a person's explicit pick
// (switchAccount, or an older editor's `account`) moves a conversation to another account.
// A held turn is a stored copy, which a turn written before the port routed it may have left unnamed.
const pressed = (held: AgentTurn, routing: ResumeRouting): Routing => {
    const { agent: provider, harness, account } = withRuntimeDefaults(held);
    return routingFor({ provider, harness, account }, routing);
};

// Whether the press keeps the held turn's runtime (provider and loop), whatever it does to the account.
const sameRuntime = (input: AgentTurn, routing: ResumeRouting): boolean => {
    const where = pressed(input, routing);
    const held = withRuntimeDefaults(input);
    return where.provider === held.agent && where.harness === held.harness;
};

// The turn's own fields come from the held copy; routing (agent/harness/account/model) comes from the press when named.
// Destructure-then-add so a press onto another runtime leaves none of the old runtime's fields standing.
const reroutedInput = (input: TurnInput & { conversationId: string }, routing: ResumeRouting | undefined): TurnInput & { conversationId: string } => {
    if (routing === undefined) {
        return input;
    }
    const { agent: _agent, harness: _harness, account: _account, model: _model, ...rest } = input;
    // No model in the press keeps the refused turn's; an unloaded catalog has no pick to send.
    const model = routing.model ?? input.model;
    const { account } = pressed(input, routing);
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
    routing !== undefined && (!sameRuntime(input, routing) || (pressed(input, routing).account !== input.account && routing.carry !== true));

// Same runtime, different account: the case the `carried` note describes.
const movesAccount = (input: AgentTurn, routing: ResumeRouting | undefined): boolean =>
    routing !== undefined && sameRuntime(input, routing) && pressed(input, routing).account !== input.account;

// A re-run's note, whether it opens fresh, and whether it replaces an earlier attempt's note rather than keeping it.
interface RerunNote {
    readonly reason: ResumeReason;
    readonly fresh?: true;
    readonly restate?: true;
}

// The ways on a spent allowance's held turn can take where it is going: carrying or trimming the session needs the turn
// to have run, its session not refused, and the press to keep its runtime; a summary goes anywhere.
const handoffCan = (held: HeldTurn, routing: ResumeRouting | undefined, offer: HandoffOffer, mode: HandoffMode): boolean => {
    if (offer[mode] === undefined) {
        return false;
    }
    return mode === "summary" || (held.ran && held.carryRefused !== true && (routing === undefined || sameRuntime(held.input, routing)));
};

// Which way a held turn the owner had a choice for continues: the press's own word, else the person's pick on the card,
// else an older editor's `carry`, else the suggestion the card showed. A way the destination cannot take (another
// provider holds no session) falls to a summary, then a trim, then carrying, whichever the offer has. Undefined for a
// hold with no offer, which goes on as it always has.
export const handoffFor = (held: HeldTurn, routing: ResumeRouting | undefined): HandoffMode | undefined => {
    const offer = held.reason === "limit" ? held.handoff : undefined;
    if (offer === undefined) {
        return undefined;
    }
    const asked = routing?.handoff ?? offer.chosen ?? (routing?.carry === true ? "carry" : undefined) ?? offer.suggested;
    const can = (mode: HandoffMode): boolean => handoffCan(held, routing, offer, mode);
    return can(asked) ? asked : (["summary", "trim", "carry"] as const).find(can);
};

const handoffNote = (held: HeldTurn, routing: ResumeRouting | undefined, mode: HandoffMode): RerunNote => {
    switch (mode) {
        case "carry":
            return { reason: movesAccount(held.input, routing) ? "carried" : "limit", restate: true };
        case "trim":
            return { reason: "trimmed", restate: true };
        case "summary":
            return { reason: "summarized", fresh: true, restate: true };
    }
};

// Keeps the session when the turn ran and nothing retires it; fresh otherwise, `switched` if it ran and `refused` if not.
// A spent allowance's hold with a choice of ways on takes the one handoffFor names.
const wallNote = (held: HeldTurn, routing: ResumeRouting | undefined): RerunNote => {
    const handoff = handoffFor(held, routing);
    if (handoff !== undefined) {
        return handoffNote(held, routing, handoff);
    }
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
        // Its own session, cut back to before the stopped response, whichever model the press named; fresh only if the
        // press moved runtimes, which no session crosses.
        case "flagged":
            return retiresSession(held.input, routing) ? { reason: "flagged", fresh: true, restate: true } : { reason: "flagged", restate: true };
        default:
            return wallNote(held, routing);
    }
};

// A held turn sent again where `routing` points, by whoever sends it now; a door refusal's run joins those whose rows the
// model never saw.
const rerunOf = (held: HeldTurn, routing?: ResumeRouting): TurnInput & { conversationId: string } => {
    const turn = resumedTurn({ input: reroutedInput(held.input, routing), sessionId: held.sessionId }, rerunNote(held, routing));
    const cut = turn.sessionId === undefined || held.resumeAt === undefined ? turn : { ...turn, resumeAt: held.resumeAt };
    return held.run === undefined ? cut : { ...cut, unseenRuns: [...(held.input.unseenRuns ?? []), held.run] };
};

// Undefined when nothing a press answers for is held (an outage or a refused credential is the pass's), a turn runs, or
// the conversation is archived (a person's press reopens it at its route first).
export const fireHeldResume = async (
    services: Pick<Services, "conversations" | "turns">,
    conversationId: string,
    routing?: ResumeRouting,
): Promise<StartedRun | undefined> => {
    const held = services.conversations.state(conversationId)?.resume.held;
    if (held === undefined || held.reason === "auth" || held.reason === "outage") {
        return undefined;
    }
    const started = await services.turns.start(rerunOf(held, routing));
    return typeof started === "string" ? undefined : started;
};

// A person's Continue (agent.run `continues`), whatever the last turn left. A held turn runs again on the press's
// routing, an outage's included, since the person is asking for it now. A sign-in still being renewed goes first. With
// nothing held (a Stop, a restart since), the conversation goes on in the session it continues, with the `continued`
// note as the whole prompt: the person wrote nothing, so nothing is recorded as theirs, and the agent is not handed a
// word it would read as theirs. A door refusal is the sandbox's to keep, since no composer holds these words, so the
// next press runs it again. Undefined when a turn already holds the conversation; the caller reopens an archived one.
export const carryOnTurn = async (
    services: Pick<Services, "agents" | "conversations" | "turns">,
    turn: TurnInput & { readonly conversationId: string },
): Promise<StartedRun | undefined> => {
    const { conversationId } = turn;
    const held = services.conversations.state(conversationId)?.resume.held;
    if (held?.reason === "auth") {
        return undefined;
    }
    const { agent, harness } = withRuntimeDefaults(turn);
    const { prompt: _words, attachments: _files, mentions: _mentions, editorContext: _looking, messageId: _id, sessionId: _asked, ...rest } = turn;
    const started = await services.turns.start(
        held === undefined
            ? { ...rest, prompt: RESUME_NOTES.continued, resume: "continued", ...opt("sessionId", sessionFor(services, turn)) }
            : rerunOf(held, { agent, harness, ...opt("account", turn.account), ...opt("model", turn.model) }),
    );
    return started === "busy" || started === "archived" ? undefined : started;
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
    return override ?? (await sandboxBreakPolicy(services, ending));
};

// The sandbox-wide answer, which a conversation with no answer of its own inherits.
export const sandboxBreakPolicy = async (services: Pick<Services, "sandboxSettings">, ending: TurnBreak): Promise<TurnBreakPolicy> => {
    const settings = await services.sandboxSettings.get();
    switch (ending) {
        case "limit":
            return settings.limitPolicy;
        case "outage":
            return settings.outagePolicy;
        case "memory":
            return settings.memoryPolicy;
        default:
            return settings.stopPolicy;
    }
};

// `fresh` drops a session that holds only one unanswered message, for a record-seeded handoff instead of replaying
// provider filler. A note already on the prompt stays unless `restate` replaces it, and `resume` names the one it keeps.
const resumedTurn = (
    failure: { readonly input: TurnInput & { conversationId: string }; readonly sessionId?: string | undefined },
    { reason, fresh, restate }: RerunNote,
): TurnInput & { conversationId: string } => {
    // Destructured out first so `fresh` can unset it, rather than leaving the carried session in place via a spread. The
    // failed turn's own cut goes too: it named a point in the session as it stood then, and the work since is kept.
    const { sessionId: carried, resumeAt: _cut, ...rest } = failure.input;
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
        // A job the sandbox started with no pin runs on a provider that can serve it, never on one nobody connected.
        const fallback = turn.runRole === undefined ? undefined : await unpinnedRunProvider(services);
        return fallback === undefined ? turn : { ...turn, agent: fallback };
    }
    // The pin's provider must travel with its model: a model id is only meaningful to the provider that vends it.
    return { ...turn, agent: pinned.provider, model: pinned.model, ...pinnedKnobs(turn, pinned) };
};

// The one path every detached turn starts through, so the announcements and the journal entry live here once, not at
// each call site; `body` is the turn itself. A refusal names why no run was made.
export const startConversationTurn = async (
    services: Services,
    body: TurnStarter["stream"],
    sent: TurnInput & { readonly conversationId: string },
    { attempts = 0, senderKeeps = false, continues }: StartOptions & Pick<RunOptions, "continues"> = {},
): Promise<TurnRun | BeginRefusal> => {
    // Routed on the way in (idempotent): the one path every detached turn starts through names its provider and loop,
    // after the run role or persona pin had the chance to, since a pin fills only what the turn left unnamed.
    const turn = withRuntimeDefaults(await withRoleModel(services, sent));
    const { conversationId, prompt } = turn;
    // The record is copied now; the pump waits for it before invoking the provider.
    const transcriptOpen = openTurnTranscript(services, turn);
    const run = startTurnRun(services, body, turn, {
        journalled: true,
        before: transcriptOpen,
        opening: (startedAt) => openingRows(turn, services.workspace.root, startedAt),
        ...opt("continues", continues),
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
    if (run !== "archived" && run !== "busy") {
        // Whoever supervises this conversation hears that it is busy, and why (a spawned child's parent, children.ts).
        services.events.publish("run.started", { conversationId, speaker: turn.speaker, resume: turn.resume, errand: turn.errand });
    }
    return run;
};

export interface TurnResumeScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass; `start` runs it on an interval. A call while a pass still runs joins that pass. Exposed for tests.
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
const providerOf = (held: HeldTurn): string => withRuntimeDefaults(held.input).agent;

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
    const started = await services.turns.start(rerunOf(held, routing));
    if (typeof started !== "string") {
        const { conversationId } = held.input;
        services.logger.info({ conversationId, reason: held.reason, ...opt("account", routing?.account) }, "held turn re-run fired");
    }
    return started;
};

// The hold's one dispatch, stamped before the start so it holds even if starting conflicts; a ladder rung spends a try.
// The stamp names the record judged, and the actor refuses it unless that record is still the one held (onHeldFired),
// so a pass that read a hold before awaiting other conversations' starts never fires a copy since superseded.
const dispatch =
    (ladder: boolean): Rung["fire"] =>
    async (services, held, routing) => {
        if (services.conversations.send(held.input.conversationId, { kind: "held-fired", ladder, judged: held }).reply) {
            await rerun(services, held, routing);
        }
    };

// Whether the conversation still holds the very record the pass read: every change to a hold makes a new record, so a
// different one is a hold replaced, re-pointed or fired since, which the next pass judges as it stands. Asked right
// before acting, with no await in between, where an act other than a fire (a drop, a give-up) would land on it.
const stillHeld = (services: Pick<Services, "conversations">, conversationId: string, held: HeldRecord): boolean =>
    services.conversations.state(conversationId)?.resume.held === held;

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
    if (services.conversations.state(conversationId)?.resume.authFiring === true || !stillHeld(services, conversationId, held)) {
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

// The instant (ms) a spent allowance's hold is booked to go at its reset, or undefined: none named, or one already past
// at the refusal, which would loop. One answer for the pass that fires it and the wake that keeps the machine up for it.
const limitReopensAt = (held: HeldRecord): number | undefined => {
    const reopensAt = held.reopensAt === undefined ? undefined : held.reopensAt * 1000;
    return reopensAt === undefined || reopensAt <= held.recordedAt ? undefined : reopensAt;
};

// A door hold has no rung: whether a turn goes past the wall that stopped it is a person's call, not a clock's. The one
// door a moment's wait clears by itself, low memory, is let go on its own answer once there is room (releaseRoomHolds).
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
            if (!stillHeld(services, held.input.conversationId, held)) {
                return;
            }
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
                const { agent, harness } = withRuntimeDefaults(input);
                return { routing: { agent, harness, account: move.account, carry: move.carry } };
            }
            const reopensAt = limitReopensAt(held);
            if (reopensAt === undefined || reopensAt > now) {
                return undefined;
            }
            // Re-pointed since the refusal: it goes where the person picked, not back to the account that refused it.
            if (held.onto !== undefined) {
                const { agent, harness } = withRuntimeDefaults(held.input);
                return { armedBy: "limit", routing: { agent, harness, account: held.onto.account, ...(held.onto.carry ? { carry: true } : {}) } };
            }
            return { armedBy: "limit" };
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
    const withdrawn = held.move !== undefined && booked?.routing !== undefined && (await breakPolicyFor(services, conversationId, "limit")) !== "move";
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
    if (!stillHeld(services, conversationId, held)) {
        return;
    }
    if (await services.conversations.send(conversationId, { kind: "resume-abandoned", reason: verdict.gaveUp }, now).settled) {
        if (!stillHeld(services, conversationId, held)) {
            return;
        }
        services.conversations.send(conversationId, { kind: rung.spent });
        services.logger.warn({ conversationId, reason: held.reason }, "resume pass gave up the held turn, the request is settled as failed");
    }
};

// Whether the sandbox's own words wait on a window that has now reopened: admission held them while it was shut
// (turn-admission.ts), and nothing else would send them where the answer to the limit is to wait for a press.
const wakesReopened = (services: Services, conversationId: string, held: HeldRecord, now: number): boolean =>
    held.reason === "limit" &&
    held.reopensAt !== undefined &&
    !windowShut(held, now) &&
    waitingOf(services.conversations.queued(conversationId)).some((item) => item.voice !== "person");

// Whether what a scheduled send waits for has come: its instant, or the conversation it waits on finished with all of its
// work in the workspace (work-landed.ts).
const bookingDue = (services: Services, booking: Booking, now: number): boolean =>
    booking.after === undefined ? booking.until <= now : workLanded(services, booking.after.conversationId, booking.after.since);

// Whether a message still waits by the same booking: a person may have sent it, taken it back or re-timed it while the
// release waited on a version commit, and their word is the newer one.
const sameBooking = (held: Booking | undefined, booked: Booking): boolean =>
    held !== undefined && held.until === booked.until && held.after?.conversationId === booked.after?.conversationId;

// Lets one conversation's due scheduled sends go, and only those: every other booking keeps its time. One that waited on
// another conversation's land first waits out that land's version commit (version-landed.ts), so the turn it starts reads
// that work committed under its own subject, rather than sweeping it into the "Your edits" commit an isolated turn makes
// of the main tree before it starts (versionMainTree). Each message's booking is read again after that wait, and only one
// still booked the same goes.
const letGo = async (services: Services, conversationId: string, due: readonly Booked[], now: number): Promise<void> => {
    const lands = new Set(due.flatMap(({ booking }) => (booking.after === undefined ? [] : [booking.after.conversationId])));
    if (lands.size > 0) {
        await versionCommitsSettled(services, [...new Set([...lands].flatMap((land) => landingRepos(services, land)))]);
    }
    const { items } = services.conversations.queued(conversationId);
    const still = due.filter(({ id, booking }) => {
        const item = items.find((waiting) => waiting.id === id);
        return item !== undefined && sameBooking(bookingOfItem(item), booking);
    });
    if (still.length === 0) {
        return;
    }
    services.conversations.send(conversationId, { kind: "queue-released", ids: still.map(({ id }) => id) }, now);
    services.logger.info(
        { conversationId, messages: still.length, after: [...lands] },
        lands.size === 0 ? "resume pass: a scheduled send's time came, it goes out" : "resume pass: the work a scheduled send waited for landed, it goes out",
    );
    await services.turns.drain(conversationId);
};

// A person's scheduled sends whose time has come (turn-admission.ts, bookingFor): their bookings are let go and they go
// out as the ordinary turn they would have been, together where they fall due together. Should the allowance still be
// spent, that turn is refused like any other, and the conversation's limit answer (which the composer arms to resend)
// takes it from there.
const releaseBooked = async (services: Services, now: number): Promise<void> => {
    const due = new Map<string, Booked[]>();
    for (const booked of services.conversations.booked()) {
        if (bookingDue(services, booked.booking, now)) {
            due.set(booked.conversationId, [...(due.get(booked.conversationId) ?? []), booked]);
        }
    }
    for (const [conversationId, messages] of due) {
        try {
            await letGo(services, conversationId, messages, now);
        } catch (error) {
            services.logger.error({ err: error, conversationId }, "resume pass: a scheduled send could not be let go, the pass goes on to the next");
        }
    }
};

// How long memory must stay free before a hold waiting for room lets anything go: one good reading between two short ones
// is not memory calming down, and a turn let go into it is refused again, with a second notice in its chat.
export const ROOM_SETTLE_MS = 30_000;

// What a low-memory refusal left waiting: a person's words, held in the conversation's queue (turn-admission.ts,
// handBack), or a turn the sandbox kept whole at the door (`door`), and since when.
type RoomHold =
    | { readonly conversationId: string; readonly since: number; readonly kind: "queue" }
    | { readonly conversationId: string; readonly since: number; readonly kind: "door"; readonly held: HeldRecord };

// Whether the turn a conversation last tried was turned away because the sandbox was short of memory: the one refusal at
// the door that a moment's wait clears by itself. The card reads the same ending (agentStatus.ts, memoryHeld).
const memoryRefused = (services: Pick<Services, "agents">, conversationId: string): boolean => {
    const ending = services.agents.entry(conversationId)?.ending;
    return ending?.kind === "failed" && ending.code === "sandbox-memory-low";
};

// Every low-memory hold, longest waiting first, one per conversation.
const roomHolds = (services: Pick<Services, "agents" | "conversations">): readonly RoomHold[] => {
    const queues = services.conversations.refused().map(({ conversationId, since }): RoomHold => ({ conversationId, since, kind: "queue" }));
    const doors = services.conversations
        .stranded()
        .flatMap(({ conversationId, record }): RoomHold[] =>
            record.reason === "door" && !record.fired ? [{ conversationId, since: record.recordedAt, kind: "door", held: record }] : [],
        );
    const held = [...queues, ...doors].filter((hold) => memoryRefused(services, hold.conversationId)).sort((a, b) => a.since - b.since);
    return held.filter((hold, index) => held.findIndex((other) => other.conversationId === hold.conversationId) === index);
};

// Lets one low-memory hold go, once memory has stayed free for ROOM_SETTLE_MS, and only where the conversation's answer to
// the memory wall is to send it then. One a pass, longest waiting first: the next is judged on a reading that counts the
// room the first one took (resource-budget.ts reservations), where letting them all go into one good reading would have
// every one of them refused again at once. Its words go out as the ordinary turn they would have been; the sandbox's
// kept turn runs as itself, as its press would run it.
const releaseRoomHolds = async (services: Services, now: number): Promise<void> => {
    const holds = roomHolds(services);
    if (holds.length === 0) {
        return;
    }
    let next: RoomHold | undefined;
    for (const hold of holds) {
        if (breakArmed(await breakPolicyFor(services, hold.conversationId, "memory"))) {
            next = hold;
            break;
        }
    }
    if (next === undefined) {
        return;
    }
    const since = await services.resources.roomSince();
    if (since === undefined || now - since < ROOM_SETTLE_MS) {
        return;
    }
    const { conversationId } = next;
    services.logger.info({ conversationId, kind: next.kind, waitedMs: now - next.since }, "resume pass: memory freed up, a held message goes out");
    if (next.kind === "door") {
        await dispatch(false)(services, next.held, undefined, now);
        return;
    }
    const ids = waitingOf(services.conversations.queued(conversationId)).map((item) => item.id);
    services.conversations.send(conversationId, { kind: "queue-released", ids }, now);
    await services.turns.drain(conversationId);
};

// When a spent allowance's unfired hold goes by itself, read the way the pass reads it (RUNGS.limit, runRung): a booked
// move at once while the conversation still answers the limit with a move, else its reset where it answers with any send.
// Undefined for a hold only a press sends.
const heldSendAt = async (services: Pick<Services, "agents" | "sandboxSettings">, conversationId: string, held: HeldRecord): Promise<number | undefined> => {
    if (held.reason !== "limit" || held.fired) {
        return undefined;
    }
    const policy = await breakPolicyFor(services, conversationId, "limit");
    if (!breakArmed(policy)) {
        return undefined;
    }
    return held.move !== undefined && policy === "move" ? held.recordedAt : limitReopensAt(held);
};

/**
 * The soonest instant the sandbox's own clock sends something a conversation is waiting on (ms), or 0 for none: a
 * person's scheduled send, and a spent allowance's held turn booked to go again at its reset. A wake the machine must not
 * sleep through, since nothing outside restarts it for either.
 */
export const nextBookedSendAt = async (services: Pick<Services, "agents" | "conversations" | "sandboxSettings">): Promise<number> => {
    const scheduled = services.conversations.booked().flatMap(({ booking }) => (booking.until === undefined ? [] : [booking.until]));
    const held = await Promise.all(services.conversations.stranded().map(({ conversationId, record }) => heldSendAt(services, conversationId, record)));
    const instants = [...scheduled, ...held.filter((at): at is number => at !== undefined)];
    return instants.length === 0 ? 0 : Math.min(...instants);
};

// One pass over every held turn, oldest first; snapshotted, since every rung stamps or drops the records it walks.
export const createTurnResumeScheduler = (services: Services, intervalMs = 5_000): TurnResumeScheduler => {
    let timer: NodeJS.Timeout | undefined;
    // One pass at a time: an interval that comes round while the last pass still runs joins it instead of walking the
    // same records underneath it. A rung reads a policy before it stamps its record, and a second pass walking a stale
    // snapshot could fire the same hold twice; a send let go waits on a version commit, and must not be let go again.
    const passes = new SingleFlight<"pass", void>();

    const pass = async (now: number): Promise<void> => {
        for (const { conversationId, record } of services.conversations.stranded()) {
            // Per conversation, so one record that throws leaves the rest of the pass to run.
            try {
                await runRung(services, conversationId, record, now);
                // After the rung, so a resend it just fired goes first and hears them as it runs.
                if (wakesReopened(services, conversationId, record, now)) {
                    await services.turns.drain(conversationId);
                }
            } catch (error) {
                services.logger.error({ err: error, conversationId, reason: record.reason }, "resume pass: a held turn could not be resumed, the pass goes on to the next");
            }
        }
        await releaseBooked(services, now);
        try {
            await releaseRoomHolds(services, now);
        } catch (error) {
            services.logger.error({ err: error }, "resume pass: a low-memory hold could not be let go, the next pass tries again");
        }
    };
    const tick = (now: number = Date.now()): Promise<void> => passes.run("pass", () => pass(now));

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

// A card in a carried-on run's rows that nothing will raise again, frozen as nobody's decision, as the run's end would
// have frozen it: its waiter died with the daemon, so an answer to it would go nowhere.
const frozenUnlessRaised = (row: TranscriptRow, raised: ReadonlySet<string>): TranscriptRow => {
    if (!isAwaitingDecision(row)) {
        return row;
    }
    const stale = Object.fromEntries(
        REQUEST_FIELDS.flatMap((field) => {
            const card = row[field];
            return card?.status === "pending" && !raised.has(card.requestId) ? [[field, card]] : [];
        }),
    );
    return { ...row, ...cancelledRequests(stale) };
};

/* A PARKED RUN COMES BACK AS ITSELF. It carries on under the id, the start and the rows it had when the daemon died,
   so every copy of it agrees: a window that was showing it redraws it in place (its rows are found by that id), the
   record it settles into holds what it did before it asked, and the prompt keeps the time it was sent. A new run that
   told the prompt again drew the prompt and the card a second time beneath the first, answerable twice, and the record
   kept neither the work nor the hour (2026-10-06). An entry an older build journalled holds no rows: that run opens on
   its prompt again, still at the time it was sent. */
const carriedRun = (services: Services, entry: JournalledTurn): NonNullable<RunOptions["continues"]> => {
    const raised = new Set((entry.parked ?? []).map((request) => request.requestId));
    const rows = entry.run?.rows?.map((row) => frozenUnlessRaised(row, raised)) ?? openingRows(entry.turn, services.workspace.root, entry.startedAt);
    return { id: entry.run?.id ?? crypto.randomUUID(), startedAt: entry.startedAt, rows };
};

// Restores parked requests verbatim under their original request ids, via a placeholder turn on the ordinary start path
// that carries on the parked run itself (carriedRun). The answer's turn starts on the journalled session only after the
// placeholder fully unwinds and releases the mutex. Answers the refusal when no placeholder could start (an archived
// conversation, a live turn already holding it).
const rehydrateParkedTurn = async (services: Services, entry: JournalledTurn): Promise<string | undefined> => {
    const conversationId = entry.turn.conversationId;
    const requests = entry.parked ?? [];
    const sessionId = entry.sessionId ?? entry.turn.sessionId;
    // Set before the placeholder returns, read after its run unwinds; a closure since the pump owns the generator.
    let followUp: (AgentTurn & { conversationId: string }) | undefined;
    // Unlike resumedTurn (which repeats the original prompt), this turn's prompt is the user's answer itself: a message of
    // its own, so it leaves the prompt's id behind, which names the parked run's opening row and nothing else.
    const { messageId: _prompt, ...asked } = entry.turn;
    const resumed = (answer: string, mode?: AgentTurn["permissionMode"]): TurnInput & { conversationId: string } => ({
        ...asked,
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
            // feedback, framed as the live gate frames it, so notes that read like consent are never leave to execute.
            return reply.approve ? resumed("The user approved the plan: proceed with it.", POST_PLAN_MODE) : resumed(planRevision(reply.feedback), "plan");
        }
        if (request.kind === "question" && reply.kind === "question") {
            return reply.cancelled === true || reply.answers === undefined ? undefined : resumed(formatAnswers(request.questions, reply, services.workspace.root));
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
    const run = await startConversationTurn(services, placeholder, withRuntimeDefaults(entry.turn), {
        attempts: entry.attempts,
        continues: carriedRun(services, entry),
    });
    if (typeof run === "string") {
        // A live turn already owns the conversation, superseding the park as a hand retry would; or nobody reopened it.
        return run;
    }
    services.logger.info({ conversationId, requests: requests.length }, "parked turn rehydrated, its requests are back where they were");
    // Detached: the handoff waits out the whole run, and a request may sit unanswered for days without blocking boot.
    void (async () => {
        // On the record first: the answer's turn writes its own rows, and they belong under the work they answer.
        await run.waitUntilRecorded();
        if (followUp === undefined) {
            return;
        }
        // The answer to a restored card is a person's, which reopens the conversation should it have been archived since.
        await services.agents.clearArchived([conversationId]);
        const started = await services.turns.start(followUp);
        if (typeof started !== "string") {
            services.logger.info({ conversationId }, "parked turn resumed: the user's answer continues its session");
            return;
        }
        if (started !== "busy") {
            services.logger.warn({ conversationId, refusal: started }, "parked turn's answer not delivered: the conversation refused it");
            return;
        }
        // A starter that does not wait behind the promised resume took the conversation first (an automation's fire, a
        // re-run, a fix press). The answer is still the person's words, so it goes where theirs would: into that turn
        // where it takes words, else behind it in the queue, rather than nowhere.
        const said = await services.turns.say({ turn: followUp, voice: "person" });
        if ("delivered" in said) {
            services.logger.info(
                { conversationId, delivered: said.delivered },
                "parked turn's answer went to the turn that took the conversation first, or waits behind it",
            );
        } else {
            services.logger.warn({ conversationId, said }, "parked turn's answer not delivered: the conversation took nothing");
        }
    })().catch((error: unknown) => services.logger.error({ err: error, conversationId }, "parked turn's answer failed to resume it"));
    return undefined;
};

// A parked turn whose cards could not be put back: the refusal or the error is spent as an attempt, so one that can
// never come back (its conversation archived, say) stops being tried at every boot once the cap is reached, and then
// stands on the record as interrupted, with the reason in the log (2026-10-05).
const parkedNotRestored = async (services: Services, entry: JournalledTurn, reason: string): Promise<void> => {
    const { conversationId } = entry.turn;
    if (!parkedRestoreSpent({ ...entry, attempts: entry.attempts + 1 })) {
        await spendAttempt(services, entry);
        services.logger.warn({ conversationId, reason, attempts: entry.attempts + 1 }, "parked turn not restored this boot, tried again at the next");
        return;
    }
    await settleParked(services, entry, reason);
};

// Puts a parked turn's cards back, or, once it has failed to come back as often as it may, gives it up.
const restoreParked = async (services: Services, entry: JournalledTurn): Promise<void> => {
    if (parkedRestoreSpent(entry)) {
        await settleParked(services, entry, "spent");
        return;
    }
    const refused = await rehydrateParkedTurn(services, entry).catch((error: unknown) => {
        services.logger.error({ err: error, conversationId: entry.turn.conversationId }, "parked turn failed to rehydrate");
        return errorMessage(error);
    });
    if (refused !== undefined) {
        await parkedNotRestored(services, entry, refused);
    }
};

// Gives a parked turn up for good: its cards are not coming back, and its conversation's record says it was cut.
const settleParked = async (services: Services, entry: JournalledTurn, reason: string): Promise<void> => {
    const { conversationId } = entry.turn;
    // The rows it journalled while it waited are what it had drawn; the provider's store is asked only without them.
    const recorded = await recordInterruptedTurn(services, entry.turn, entry.sessionId ?? entry.turn.sessionId, entry.startedAt, {
        drawn: entry.run?.rows,
    })
        // allow(silent-catch): a record that could not be written is the warning's `recorded: false` below; the turn is
        // given up either way.
        .catch(() => false);
    await consumeEntry(services, entry);
    services.logger.warn(
        { conversationId, reason, attempts: entry.attempts, recorded },
        "parked turn given up: its cards could not be put back after every try, so it stands on the record as interrupted",
    );
};

// Runs once at boot, before anything else starts a turn on these conversations. Surviving means never settled; each
// entry is consumed (spent or deleted) before it restarts, so a turn that kills the daemon can't loop the boot. An
// automation's interrupted fire is its scheduler's to re-fire (automations/fire-resume.ts). `ownerAsked`: the restart
// this boot follows was one the owner started and asked to pick up after (restart-resume.ts), which resumes the turns
// it cut as autoResumeOnRestart would, this once. `restartStorm`: this boot is one of a restart storm
// (system/boot/boot-history.ts), which resumes nothing, ask or setting, and leaves every cut turn interrupted on the
// record (2026-10-05).
export const resumeInterruptedTurns = async (services: Services, now: number = Date.now(), ownerAsked = false, restartStorm = false): Promise<void> => {
    const listed = await services.turnJournal.list().catch((error: unknown): JournalEntry[] => {
        services.logger.warn({ err: error }, "turn journal: unreadable at boot, no interrupted turn is resumed");
        return [];
    });
    const interrupted = listed.filter((entry): entry is JournalledTurn => entry.kind === "turn");
    if (interrupted.length === 0) {
        return;
    }
    const autoResumeOnRestart = !restartStorm && (ownerAsked || (await services.sandboxSettings.get()).autoResumeOnRestart);
    for (const entry of interrupted) {
        // Skips every gate below: rehydration spends nothing and isn't an attempt, so autoResumeOnRestart, staleness
        // and the attempt cap don't apply. Not cleared here either; the placeholder re-journals it, so a second restart
        // rehydrates again.
        if (entry.parked !== undefined && entry.parked.length > 0) {
            await restoreParked(services, entry);
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
                { entry: entry.kind, spent, stale, autoResumeOnRestart, restartStorm },
                "interrupted turn not resumed: the interruption stands on the record",
            );
            continue;
        }
        // The cut turn never settled, so nothing recorded it, and the re-run's prompt carries the restart note, which
        // records a notice where the user's bubble would be: written here, before the re-run, or the message is gone
        // from the record (and from the receipts seeded off it). A failed write keeps the entry, attempt unspent.
        if (!(await recordInterruptedTurn(services, entry.turn, entry.sessionId ?? entry.turn.sessionId, entry.startedAt, { resuming: true }))) {
            services.logger.warn(
                { conversationId: entry.turn.conversationId },
                "interrupted turn transcript could not be written before its re-run; journal entry was retained",
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
const restartTurnOf = (entry: JournalledTurn): TurnInput & { conversationId: string } =>
    resumedTurn({ input: entry.turn, sessionId: entry.sessionId }, { reason: "restart" });
