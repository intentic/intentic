import {
    type AgentEvent,
    type AgentReply,
    type AgentRunPin,
    type AgentTurn,
    type ParkedCard,
    RESUME_NOTES,
    type ResumeRouting,
    withoutResumeNote,
    withResumeNote,
} from "@intentic/sandbox-contract";
import { fireAutomation, type WakeFn } from "../automations/scheduler.js";
import { replaceRejectedToken } from "../claude/claude-credentials.js";
import type { Services } from "../composition.js";
import { turnAwaiting, turnFinished } from "../push/notifications.js";
import { openTurnTranscript, recordInterruptedTurn, recordTurnTranscript } from "../sessions/turn-transcript.js";
import { grantRestoredPermission, POST_PLAN_MODE } from "./agent.js";
import { formatAnswers } from "./question-answers.js";
import { restoreRequest } from "./agent-requests.js";
import { agentRunModel } from "./agent-run-model.js";
import { registerTurn } from "./agent-steering.js";
import { outageRetryDue, outageRetryFired } from "./provider-health.js";
import type { JournalEntry, JournalledTurn } from "./turn-journal.js";
import { startTurnRun, type TurnRun } from "./turn-runs.js";

/* RE-RUNNING A TURN WHOSE BLOCKER HAS CLEARED, three conditions, one mechanism.
 *
 * Some turns do not fail because the work was wrong. They fail because something underneath them stopped
 * working for a while, and a moment later it works again. Re-running such a turn is not a retry policy, it is
 * the completion of a turn the user already asked for; leaving it dead means every open tab needs a human to
 * type "continue" into it, which is precisely the morning this module exists to prevent.
 *
 * A SPENT USAGE LIMIT is the condition deliberately absent from that list. The turn is not broken, it is EARLY,
 * and the reset instant rides on the failure, so it looks like the easiest of the four. It is not, because the
 * allowance is the user's OWN budget: every other blocker here clears at no cost to them, while this one clears
 * into a window they may have been saving. So a usage limit stops the turn, says when it resets, and re-runs
 * nothing; sending again is the user's call to make.
 *
 * AUTH. The access token the turn snapshotted at spawn stopped being accepted, almost always because a
 * rotation superseded it, which Anthropic answers with "401 OAuth access token has been revoked" on the old
 * one. There is no instant to wait for here: the replacement either exists the moment we ask or the credential
 * is genuinely dead, so this fires immediately rather than through the poll, and it is NOT gated on a setting
 *, a spent allowance is the user's budget to spend, while a rotated token is the daemon's own bookkeeping
 * breaking a turn nobody chose to break.
 *
 * PROVIDER OUTAGE. The model provider itself failed: 500/502/503, a 529 at capacity, a dropped socket, and
 * the harness's own long in-turn retry budget did not outlast it. This one has no instant to wait for AND no
 * credential to repair: nobody can say when the provider comes back, only that asking again is worth something
 * and asking constantly is worth nothing. So the WHEN is owned by a shared per-provider breaker
 * (provider-health.ts) rather than by this map, and the rule here is only which stranded turn gets the one
 * attempt that breaker permits.
 *
 * RESTART. The daemon itself stopped existing under the turn. This one is not remembered in memory at all, the
 * process that would hold the note is the process that died, so it rides the on-disk turn journal, and the
 * "blocker" clears by definition: the daemon is back, which is what running this pass at boot means. It is the
 * same argument as AUTH, only more so, because the killing is usually intentic's OWN doing: the container is
 * recreated on every update, every environment approval and every dev-sandbox.sh swap. "Approve the Dockerfile
 * change your agent asked for" must not also mean "and lose the forty-minute run that asked for it".
 *
 * Daemon-side on purpose, all four: the whole point of detached runs is that turns outlive browser tabs, and a
 * resume that died with the tab would miss exactly the failures worth automating (a 5-hour window lapsing
 * overnight; a token rotating while the operator is away; a provider that is down for the twenty minutes
 * somebody spent at lunch; a rebuild landing while they wait for it).
 *
 * Keyed by conversationId, like turn-runs: one pending resume per conversation, and any NEW turn on the
 * conversation supersedes it (the user retrying by hand must not be doubled by the scheduler). */

/* How long a stranded outage turn stays worth resuming. An outage has no known end, and its attempt budget is
 * spent inside forty minutes: past the hour either the provider is still down or the user has read the red line
 * and moved on, and a turn that springs back to life hours after they did is a worse outcome than one that
 * stayed dead. */
const OUTAGE_STALE_AFTER_MS = 60 * 60_000;

/* How old an interrupted turn may be and still be worth re-running at boot. Generous enough to cover the case
 * this is FOR, a long agent run plus a container rebuild, and short enough that a sandbox switched off for the
 * weekend does not come back mid-thought on Monday, acting on a world that has moved on. The clock is the turn's
 * own start, since nothing records when the daemon died. */
const RESUME_MAX_AGE_MS = 6 * 60 * 60_000;

/* How many times a boot may re-run one turn. Exactly once: a turn whose own tool output OOM-kills the daemon
 * would otherwise resurrect it on every boot for the life of the sandbox, and each boot would cost a fresh
 * turn's spend to reach the same crash. The entry is rewritten with the spent attempt BEFORE the resume starts,
 * so the counter survives the death it is guarding against. */
const MAX_RESUME_ATTEMPTS = 1;

/* HOW LONG A CARD MAY SAY "COMING BACK" BEFORE IT HAS TO STOP SAYING IT.
 *
 * The auth failure frame promises the client a renewal (autoResume: "scheduled"), and the fleet card holds
 * itself out of every settled lane on the strength of that promise, a spinner with an elapsed counter and no
 * ending. Nothing else can end it: `finish` deliberately does not clear the wait (the resume outlives the turn
 * it belongs to), so the only two ways out are the resumed turn's own begin and abandonResume below.
 *
 * Which makes every silent exit from a resume a permanently spinning card, and there are several, the token
 * endpoint hanging, a conflict on the conversation, an abandon lost to a turn that had not finished unwinding.
 * They used to share one fate: the pending entry was dropped BEFORE the attempt, so whatever went wrong went
 * wrong exactly once and left nothing behind to notice it. Now the entry survives its attempts and this is the
 * clock they run against, the re-mint is one HTTPS round trip fired within a pass of the failure, so a minute
 * of passes is far past generous, and what is still waiting at the end of it is not waiting for anything. */
const AUTH_RESUME_DEADLINE_MS = 60_000;

// What the card says when that minute runs out. It is the sentence for the one auth ending a person has to act
// on, so it names the act rather than the machinery, see abandonResume.
const AUTH_GAVE_UP = "The Claude sign-in this turn ran on could not be renewed in time: reconnect the account, then send again.";

// Every turn start clears its conversation's pending resumes, all three kinds. Whatever runs next (the user
// retrying by hand, a press on the held turn, the scheduler's own fire) supersedes them. The held-limit entry
// belongs here for a reason its neighbours do not have: a user who answers a refusal by TYPING something new has
// decided against re-running the old turn, and leaving it armed would offer them a press that undoes their own
// message by starting a turn on top of it.
export const clearPendingResume = (conversationId: string): void => {
    pendingAuth.delete(conversationId);
    pendingOutage.delete(conversationId);
    pendingLimit.delete(conversationId);
};

export interface AuthFailure {
    readonly input: AgentTurn & { conversationId: string };
    // The session the failed turn last reported, it holds whatever partial work preceded the 401.
    readonly sessionId?: string;
    // The account whose token was refused, and the exact token that was refused. Both are needed: the account
    // says which credential to re-mint, and the token is what the rotation must supersede rather than replay.
    readonly account: string;
    readonly refusedToken: string;
}

const pendingAuth = new Map<string, AuthFailure & { readonly recordedAt: number }>();

// Conversations with an attempt in flight right now. The entry is no longer dropped when its attempt starts, so
// without this a re-mint slower than the poll would be fired again underneath itself once every five seconds.
const firingAuth = new Set<string>();

/* Whether an auth-killed turn with THIS prompt is one this module will re-run. False for a turn that is ITSELF a
 * resume: a credential that refuses the freshly minted token too is not a transient rotation, and re-running
 * against it forever would be worse than the one red frame that now stands.
 *
 * Exported because the failure FRAME has to say whether anything is coming back, and the frame goes out while the
 * turn is still unwinding, before recordAuthFailure runs in its finally. Without it the chat has to guess, which
 * is how "the credential is being renewed and this turn continues automatically" came to be printed under turns
 * that were never coming back. */
export const authResumable = (prompt: string): boolean => !prompt.startsWith(RESUME_NOTES.auth);

/* Remember an auth-killed turn for the next scheduler pass. Recorded from the turn's own exit rather than
 * resumed there and then, because the failing run still owns its conversation at that moment, starting the
 * replacement inline would hit turn-runs' conflict and drop the resume on the floor. The poll is a few seconds
 * behind, and the alternative is a tab that stays dead until a human types into it.
 *
 * `recordedAt` is the instant the card started promising to come back, which is what AUTH_RESUME_DEADLINE_MS is
 * measured from, the promise and the clock on it begin together. */
export const recordAuthFailure = (failure: AuthFailure, now: number = Date.now()): void => {
    if (!authResumable(failure.input.prompt)) {
        return;
    }
    pendingAuth.set(failure.input.conversationId, { ...failure, recordedAt: now });
};

export interface OutageFailure {
    readonly input: AgentTurn & { conversationId: string };
    // The session the failed turn last reported, it holds whatever partial work preceded the outage, which for
    // a mid-turn 500 can be most of the work.
    readonly sessionId?: string;
    // Whose outage this was: the breaker's key, so a Claude outage never gates a Codex conversation's resume.
    readonly provider: string;
}

const pendingOutage = new Map<string, OutageFailure & { readonly recordedAt: number }>();

/* Remember a turn the provider killed. Recorded unconditionally, including for a turn that is ITSELF a resume,
 * which is the opposite of the auth rule above and deliberately so: a re-minted token that gets refused again
 * means the credential is dead and retrying is hopeless, whereas a provider that is still down means the outage
 * is simply longer than one attempt, which is the normal case and the reason a backoff exists at all.
 *
 * Recorded whatever the posture says, the setting's, this conversation's, either: the failure frame tells the
 * client an "available" resume exists, and arming it right afterwards has to arm exactly the turn that just
 * bounced. What bounds the retrying is the breaker's attempt budget and the staleness sweep below, never this
 * call. */
export const recordOutageFailure = (failure: OutageFailure, now: number = Date.now()): void => {
    pendingOutage.set(failure.input.conversationId, { ...failure, recordedAt: now });
};

export const pendingOutageFailure = (conversationId: string): OutageFailure | undefined => pendingOutage.get(conversationId);

/* A TURN A SPENT ALLOWANCE STRANDED, HELD FOR A PRESS AND, WHERE THE USER HAS ASKED FOR IT, FOR A CLOCK.
 *
 * The header above says why a usage limit is not auto-resumed BY DEFAULT and that argument stands unchanged:
 * the allowance is the user's own budget and spending it is theirs to decide. What it never justified is the
 * absence of the CHOICE. Every other blocker here is answered by a posture the user can set; this one was
 * answered by a rule, and the rule was decided for a case (somebody is in the room, watching the chat) that
 * describes the minority of turns this product runs. A wall hit at 2am on a board nobody is watching is a card
 * that waits eight hours for a press that was always going to come.
 *
 * So the default is unchanged and the ceiling is not: `resumeAfterLimit` (per conversation, else the sandbox
 * setting) is what decides, exactly as `resumeAfterOutage` does one blocker over, and the pass below fires at
 * the instant the provider itself published rather than at a backoff anybody invented.
 *
 * What that argument never covered either is the sentence it used to end on, "sending again is the user's call
 * to make", because for as long as re-running was daemon-only the user had no way to send THIS turn again. All
 * they could do was send a NEW message after it, and since the only honest content for that message is "carry
 * on", the harness supplied the word itself.
 *
 * So the transcript filled with it. A chat that bounced off a spent allowance four times recorded four user rows
 * reading "Continue", the fourth turn read all four back, and the provider session underneath had accumulated a
 * CLI-materialized "Continue from where you left off." and a synthetic "No response requested." above each one:
 * twelve turns of the model's context describing three refusals it was never told about, four of them assistant
 * turns it never produced. The one thing the model could not learn from any of it was that a provider had said
 * no. This entry is what a press reaches instead.
 *
 * NO STALENESS SWEEP, unlike its neighbours, and the automatic fire below does not introduce one. An entry that
 * goes stale is an entry nobody pressed and no clock reached, it costs one map slot, and it is cleared by the
 * next turn on the conversation whatever starts it (clearPendingResume). A press hours later is a person
 * deliberately picking work back up, which is exactly what a reset instant hours out invites, and refusing them
 * on age would be this module inventing a deadline the allowance never had. */
export interface LimitFailure {
    readonly input: AgentTurn & { conversationId: string };
    // The session the failed turn last reported. Kept even when the turn did nothing with it, so the fire can
    // decide (see `ran`); dropping it here would make the two cases indistinguishable one layer down.
    readonly sessionId?: string;
    /* WHEN THE REFUSED ALLOWANCE IS DUE BACK (epoch seconds), as the failure itself named it, and the only
     * thing an automatic fire can be scheduled against. Absent is a real answer and a common one: Grok
     * publishes no readable quota and Cursor is not routed through the translator, so for those two there is
     * nothing to wait for and the entry stays press-only however the posture is set. A guessed instant would be
     * strictly worse than none, since what it buys is a request fired into a window that has not opened. */
    readonly reopensAt?: number;
    /* Whether the refused turn got ANYWHERE before the allowance stopped it, and the only field the fire
     * branches on. False is the common case and the one worth naming: an allowance that is already spent refuses
     * the first request of the turn, so nothing ran, the session holds one unanswered message, and both the
     * session and the note that would tell the model to "continue from that point" are actively wrong to reuse
     * (see resumedTurn's `fresh`, and RESUME_NOTES.refused). True is a limit reached mid-flight, where the
     * session holds real work and throwing it away would make the press cost more than it saves. */
    readonly ran: boolean;
}

/* `recordedAt` is what the automatic fire measures its one sanity check against, and `fired` is what stops it
 * happening twice. Both are the pass's bookkeeping rather than the failure's, which is why they live on the map
 * entry and not on LimitFailure: a caller recording a refusal is describing what happened, and neither of these
 * is about that. */
const pendingLimit = new Map<string, LimitFailure & { readonly recordedAt: number; readonly fired: boolean }>();

/* Hold a turn a spent allowance refused. Recorded from the turn's own exit, like its two neighbours and for the
 * same reason (the failing run still owns the conversation at that moment).
 *
 * Recorded unconditionally, including for a turn that is ITSELF already a resume: the auth rule's argument for
 * refusing that (a credential that refuses a fresh token is dead, so retrying is hopeless) has no analogue here.
 * An allowance refusing twice means the allowance is still spent, which is the ORDINARY case and says nothing at
 * all about whether the next press works, and this module is not the thing deciding when to press.
 *
 * Recorded whatever the posture says, exactly like recordOutageFailure: the failure frame tells the client an
 * "available" resume exists, and arming it right afterwards has to arm the very turn that just bounced. */
export const recordLimitFailure = (failure: LimitFailure, now: number = Date.now()): void => {
    pendingLimit.set(failure.input.conversationId, { ...failure, recordedAt: now, fired: false });
};

/** Whether a press on this conversation has a held turn to re-run, and what the strip may say about it. */
export const pendingLimitFailure = (conversationId: string): LimitFailure | undefined => pendingLimit.get(conversationId);

/* THE HELD TURN, POINTED AT WHOEVER SERVES IT NOW. Everything the turn IS comes off the held copy; the four
 * fields that say who RUNS it come off the press, when the press names them.
 *
 * Written as destructure-then-add rather than a spread over the top, the same shape and the same reason as
 * resumedTurn below: a press has to be able to UNSET what the failed turn carried (an account pin dropped in the
 * composer, a model the catalog no longer offers), and a conditional add over a whole spread leaves the old
 * value standing on exactly the path that means "not that one". */
const reroutedInput = (input: AgentTurn & { conversationId: string }, routing: ResumeRouting | undefined): AgentTurn & { conversationId: string } => {
    if (routing === undefined) {
        return input;
    }
    const { agent: _agent, harness: _harness, account: _account, model: _model, ...rest } = input;
    // A press with no model keeps the refused turn's: see ResumeRoutingSchema, an unloaded catalog has no pick to
    // send and the turn's own is a better answer than none. The other three are the press's outright.
    const model = routing.model ?? input.model;
    return {
        ...rest,
        agent: routing.agent,
        harness: routing.harness,
        ...(routing.account !== undefined ? { account: routing.account } : {}),
        ...(model !== undefined ? { model } : {}),
    };
};

/* WHETHER THE HELD SESSION SURVIVES THE PRESS. A provider session belongs to the runtime and the credential that
 * minted it, so re-pointing any of those three retires it exactly as a mid-chat switch does, and the re-run opens
 * a fresh one seeded from the daemon's record (handoffHistory). The MODEL is deliberately not in the comparison:
 * a same-provider model swap keeps its session, which is the client's own rule for an ordinary send (`resumes`
 * in turnRequest.ts), and the two must not disagree about the same conversation.
 *
 * The defaults are the wire's: an absent `agent` is claude and an absent `harness` is native, so a press that
 * spells out what the held turn left implicit is not read as a switch. */
const movedRouting = (input: AgentTurn, routing: ResumeRouting | undefined): boolean =>
    routing !== undefined &&
    (routing.agent !== (input.agent ?? "claude") || routing.harness !== (input.harness ?? "native") || routing.account !== input.account);

/* RUN THE HELD TURN AGAIN, on a press. Undefined when there is nothing held (never stranded, superseded by a
 * later turn, or the daemon restarted and this map went with it) or when a turn is already running on the
 * conversation, which is what makes a second press free rather than doubled.
 *
 * Nothing is consumed HERE: the entry is dropped by the turn this starts, through the same clearPendingResume
 * every turn start runs, and re-armed by recordLimitFailure on that turn's exit if the allowance refuses it
 * again, with a `ran` describing what THIS attempt did rather than what the last one did. So the press survives
 * being pressed and the map never holds a turn that a later turn has overtaken.
 *
 * THE PRESS MAY MOVE THE TURN TO ANOTHER ACCOUNT, and until it could, this route re-ran a refusal: a spent
 * allowance is refused by one account, the composer's switcher is what a person reaches for, and a re-run that
 * replayed the pinned account bounced off the same limit with the same sentence. So `routing` overrides the
 * turn's own (ResumeRoutingSchema has the argument), which forks the fire three ways rather than two. */
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
    // `restate` on every arm: the note has to describe THIS attempt's starting point, and a turn can cross
    // between them in any direction between presses (a refused turn that then runs and is cut off mid-flight; a
    // mid-flight failure whose re-run is refused at the door by a window that has since closed; either of them
    // moved onto a different account by the press that follows).
    if (held.ran && !movedRouting(held.input, routing)) {
        return startConversationTurn(services, wake, resumedTurn(failure, RESUME_NOTES.limit, { restate: true }));
    }
    /* FRESH ON BOTH REMAINING ARMS, for two different reasons. A turn that never ran left one unanswered message
     * in a session that is worth less than the handoff (see resumedTurn's `fresh`); a turn that DID run cannot
     * take its session onto another account at all. What separates them is only what the model is told. */
    return startConversationTurn(
        services,
        wake,
        resumedTurn(failure, held.ran ? RESUME_NOTES.switched : RESUME_NOTES.refused, { fresh: true, restate: true }),
    );
};

/* WHOSE ANSWER IT IS THAT A STRANDED TURN COMES BACK, asked in one place, because two callers ask it about
 * the same turn seconds apart and a disagreement between them is the worst possible outcome: the failure frame
 * promises the chat a retry, and the pass that would perform it declines.
 *
 * TWO LEVELS, conversation first. The sandbox setting is a standing policy about a board nobody is watching,
 * automation wakes, Discord, webhooks, and it belongs in settings because that is where you go to decide how
 * the whole thing behaves. The per-conversation override is a different sentence entirely: it is a person
 * inside one chat, looking at one dead turn, saying finish THAT. Folding the second into the first is what made
 * a single press at the moment of failure quietly rearm every agent on the board.
 *
 * Absent override ⇒ the setting answers, which is what keeps the default worth having. */
export const outageResumeArmed = async (services: Services, conversationId: string): Promise<boolean> => {
    const override = services.agents.entry(conversationId)?.resumeAfterOutage;
    if (override !== undefined) {
        return override;
    }
    const { resumeAfterOutage } = await services.sandboxSettings.get();
    return resumeAfterOutage;
};

/* The same question about the other gated blocker, and it is asked by the same two callers a few hours apart
 * rather than a few seconds: the failure frame says whether a fire is coming, and the pass that performs it
 * reads this again when the window actually opens. Same two levels, same precedence, same reason for both. */
export const limitResumeArmed = async (services: Services, conversationId: string): Promise<boolean> => {
    const override = services.agents.entry(conversationId)?.resumeAfterLimit;
    if (override !== undefined) {
        return override;
    }
    const { resumeAfterLimit } = await services.sandboxSettings.get();
    return resumeAfterLimit;
};

/* The turn a fire runs. The original prompt rides again IN FULL rather than as a bare "continue": whether
 * the CLI persisted the unprocessed user message before the refusal is its own implementation detail, and a
 * resume that guesses wrong there loses the message, repeating it costs at most a duplicate the model reads
 * past. The session override keeps partial work; with no session to return to, the turn starts a fresh one and
 * the daemon seeds it from this conversation's record, the same way a switched turn is seeded.
 *
 * `fresh` REFUSES the session on purpose, and it is the option a turn refused at the door needs. Such a turn
 * created a provider session, wrote the unprocessed prompt into it, and then produced nothing, so what is on
 * disk under that id is one unanswered message, and the append-only session file offers no way to take it back.
 * Resuming it costs more than the empty context it carries: the CLI materializes a resume of a turn that never
 * answered by writing a "Continue from where you left off." of its own and a SYNTHETIC assistant reply saying
 * "No response requested.", so every attempt against a spent allowance left the model one more turn in which it
 * appeared to have been asked something and declined. Four presses, four of those. Starting fresh instead costs
 * a record-seeded handoff (turn-transcript.ts → handoffHistory), which is the same seeding a provider switch
 * gets and is complete enough to have been built for exactly this.
 *
 * `restate` REPLACES a note already on the prompt rather than keeping it. withResumeNote is idempotent, which is
 * what stops a note stacking per press, and idempotent is the wrong answer when the REASON has changed
 * underneath: a turn refused at the door (told "nothing has been done towards it") that then runs, does some
 * work and is refused again mid-turn must stop saying nothing has been done. */
const resumedTurn = (
    failure: { readonly input: AgentTurn & { conversationId: string }; readonly sessionId?: string },
    note: string,
    options: { readonly fresh?: boolean; readonly restate?: boolean } = {},
): AgentTurn & { conversationId: string } => {
    // The turn's own id is destructured OUT before anything is added back, because `fresh` has to be able to
    // unset one the failed turn carried: spreading the input whole and then conditionally adding the resolved
    // id would leave the input's in place on exactly the path that means "not that session".
    const { sessionId: _carried, ...rest } = failure.input;
    const sessionId = options.fresh === true ? undefined : (failure.sessionId ?? _carried);
    const prompt = options.restate === true ? withoutResumeNote(failure.input.prompt) : failure.input.prompt;
    return {
        ...rest,
        prompt: withResumeNote(prompt, note),
        ...(sessionId === undefined ? {} : { sessionId }),
    };
};

/* WHAT AN UNATTENDED TURN RUNS ON. A turn a surface started names no model, because nobody touched the caret
 * on the button that started it (see AgentTurn.unattended), so the owner's `agentRunModels` answers for it —
 * the whole pin, not just its model: how hard that one thinks, on which loop, and at whose speed.
 *
 * Resolved HERE, at the one boundary every detached turn passes through, rather than at each of the five
 * surfaces that start one. Two things follow from that placement and neither is incidental: a surface added
 * tomorrow inherits the setting by declaring what it is, and the model lands on the turn BEFORE the journal
 * records it, so a run resumed after a daemon death comes back on the model it was started on rather than
 * re-resolving against a setting the user has since changed.
 *
 * THE SETTING IS A LIST and agentRunModel() walks it, stopping at the first entry this sandbox can actually
 * start (agent/agent-run-model.ts has the why, and why the walk is narrower than the quick chain's). Walked
 * once, here, for the same reason the resolution happens here at all: what the journal records has to be the
 * model the run is on, not a list it might re-read differently tomorrow.
 *
 * Fills only what is absent, which is what keeps the flag from overriding a real choice: every one of those
 * surfaces can name a model for a single run through the shared button's caret, Acceptance names one per run
 * (it fans one session out per story), and every resume below re-runs a turn that already carries whatever this
 * resolved the first time. A list that resolves to nothing leaves the turn's model unset, the daemon then
 * falls to the provider's live catalog default exactly as a composer turn with an unloaded catalog does. */
/* WHAT ELSE A PIN ANSWERS FOR, applied only where the turn is silent about it.
 *
 * Each of these is a question the pinned entry answers for itself: how hard to think, whether to reason at all,
 * whether to pay for speed, and which loop runs it. A field the user never pinned stays ABSENT rather than
 * becoming an invented default, so the provider's own answer stands, exactly as it did when a pin carried
 * nothing but a name.
 *
 * ABSENT-ONLY PER FIELD, not per pin, because these arrive from somewhere else than the model does: a surface
 * may send an `effort` for a run whose model it left to the setting (the push flow's proposed fix does), and the
 * caller's guard only proves that nobody named a MODEL.
 *
 * A table rather than four conditional spreads: what a pin can say about a run is a list worth reading in one
 * place, and it is the same list the settings row draws its footer from. */
const PIN_KNOBS = ["effort", "thinking", "fast", "harness"] as const;

const pinnedKnobs = (turn: AgentTurn, pin: AgentRunPin): Partial<AgentTurn> =>
    Object.fromEntries(
        PIN_KNOBS.filter((knob) => turn[knob] === undefined && pin[knob] !== undefined && pin[knob] !== "").map((knob) => [knob, pin[knob]]),
    );

const withAgentRunModel = async <T extends AgentTurn>(services: Services, turn: T): Promise<T> => {
    /* A TURN THAT NAMES ITS PROVIDER KEEPS IT, and the `agent` half of this guard matters as much as the
     * `model` half. The pin below carries a provider WITH its model, so filling a turn that already chose one
     * does not top it up, it moves the turn to a different provider entirely. A workflow step pinned to
     * `claude` with no model (the ordinary case: pinning a model id would go stale) would silently run on
     * whatever the sandbox's agent-run pin names, which for the one design where the provider IS the point
     *, two models racing the same request, quietly makes both arms the same model.
     *
     * Absent a model AND absent an agent is the case this is for: a surface that chose neither, which is what
     * "nobody picked a model for this turn" means. Naming an agent and no model falls to that provider's own
     * catalog default, exactly as it did before the flag existed. */
    if (turn.unattended !== true || turn.model !== undefined || turn.agent !== undefined) {
        return turn;
    }
    const pinned = await agentRunModel(services);
    if (pinned === undefined) {
        return turn;
    }
    // The pin carries a provider WITH its model, and has to: a model id is only meaningful to the provider that
    // vends it, so honouring one without the other would send a Codex id to Claude. Everything else the entry
    // says about the run rides along beside them.
    return { ...turn, agent: pinned.provider, model: pinned.model, ...pinnedKnobs(turn, pinned) };
};

/* THE one way the daemon starts a conversation's detached turn. POST /agent and all three
 * automatic resumes below. Every start needs the same three things and none of them belong at a call site: the
 * two push observers (a turn parking and a turn settling are the moments worth waking a phone for, and
 * notifyIfAway decides whether it actually is), and the journal entry that carries the turn across a daemon
 * death. Copies of that used to sit here and in agent.routes, which is several copies too many for something
 * whose failure mode is a silently unnotified or unresumable turn.
 *
 * Undefined means turn-runs found a live turn already on the conversation, which SUPERSEDES the resume exactly
 * like a hand retry does. `attempts` is how many boots have already re-run this turn; only the boot pass passes
 * it. */
export const startConversationTurn = async (
    services: Services,
    wake: WakeFn,
    started: AgentTurn & { conversationId: string },
    attempts = 0,
): Promise<TurnRun | undefined> => {
    const turn = await withAgentRunModel(services, started);
    const { conversationId, prompt } = turn;
    // Start adoption now, then make the pump wait for it before invoking the provider. A first turn opens an
    // empty record; a legacy conversation adopts only its OLD turns.
    const transcriptOpen = openTurnTranscript(services, turn);
    return startTurnRun((input, signal) => wake(services, input, signal), turn, {
        journal: services.turnJournal,
        before: transcriptOpen,
        transcript: (events, startedAt) => recordTurnTranscript(services, turn, events, startedAt),
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

/* What one attempt at an auth resume settled, and the only thing the pass needs from it: whether this pending
 * entry is finished with. "retry" is the verdict that did not exist and had to, every attempt used to consume
 * its entry, so an attempt that achieved nothing achieved nothing PERMANENTLY, with a spinner left turning over
 * it. Bounded by AUTH_RESUME_DEADLINE_MS, so retrying can never mean forever. */
type AuthVerdict = "resumed" | "dead" | "retry";

/* Re-mint the refused token and re-run the turn it killed. The rotation call is the whole safety argument: it
 * ADOPTS a token another holder already rotated to (the common case, the proactive refresh is usually what
 * refused this turn in the first place), refreshes only when the store still holds the refused one, and
 * records `invalid_grant` as terminal instead of replaying it. So a credential that is genuinely dead answers
 * undefined, no resume fires, and the coded error frame stands with its reconnect affordance, the one case
 * where a human really is required. */
const fireAuthResume = async (services: Services, wake: WakeFn, failure: AuthFailure): Promise<AuthVerdict> => {
    const conversationId = failure.input.conversationId;
    /* A THROW IS NOT AN ANSWER, and telling it apart from one is the difference between a card that recovers and
     * a card that gives up on a working account. `rotate` answers undefined for a credential it KNOWS is dead;
     * a rejected promise means the question never got asked, the token endpoint was unreachable, the request
     * timed out, the disk refused the write. Those clear on their own, so they buy another pass rather than a
     * reconnect notice the user cannot act on. */
    let replacement: string | undefined;
    try {
        replacement = await replaceRejectedToken(services.claudeStore, failure.account, failure.refusedToken);
    } catch (error) {
        services.logger.warn({ err: error, account: failure.account }, "auth auto-resume could not re-mint the refused token");
        return "retry";
    }
    // Nothing new to run on: the credential is revoked outright, or the store handed back the very token the
    // API just refused, which would fail identically the moment the turn respawned. The card has been holding
    // itself open for this since the turn stopped, so settle it: nothing is coming, and a human is needed.
    if (replacement === undefined || replacement === failure.refusedToken) {
        const settled = await services.agents.abandonResume(
            conversationId,
            Date.now(),
            "The Claude sign-in this turn ran on could not be renewed: reconnect the account, then send again.",
        );
        // The card is still unwinding the very turn this is about, and its finish() will re-open the spinner
        // over anything written now. Come back on the next pass, when there is something left to settle.
        return settled ? "dead" : "retry";
    }
    if ((await startConversationTurn(services, wake, resumedTurn(failure, RESUME_NOTES.auth))) === undefined) {
        // A live turn owns the conversation. Usually that IS the ending, the user's own send supersedes the
        // resume, and its begin clears the wait, but it is equally the failed turn still walking its cleanup,
        // which supersedes nothing. Indistinguishable from here, so keep the entry: a superseded one is dropped
        // by clearPendingResume at that turn's start, and only the other kind is still here next pass.
        return "retry";
    }
    services.logger.info({ conversationId, account: failure.account }, "auth auto-resume fired");
    return "resumed";
};

/* THE AUTH PASS. Every conversation whose credential died under it, re-minted and re-run, or, once the minute
 * is up, told that nothing is coming.
 *
 * The deadline is the half that was missing, and it is not a retry policy: it is the only thing standing behind
 * the promise the failure frame already made to the client. A resume that quietly does not happen is
 * indistinguishable, from every surface, from one that is about to. */
const runAuthPass = async (services: Services, wake: WakeFn, now: number): Promise<void> => {
    // Snapshotted before the loop: an await inside a live map iteration would also pick up a failure recorded by
    // a turn that is still settling, which this pass has no business acting on yet.
    const refused = [...pendingAuth.values()];
    for (const failure of refused) {
        const conversationId = failure.input.conversationId;
        if (now - failure.recordedAt > AUTH_RESUME_DEADLINE_MS) {
            // Checked ahead of the in-flight gate on purpose: an attempt still running at the deadline is
            // precisely the wedged case this exists for, and it must not be what keeps the card spinning. Should
            // it complete later and start its turn, that turn's begin re-opens the card, which is correct.
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

/* THE OUTAGE PASS. Every conversation stranded on a provider, in the order they were stranded, offered to the
 * breaker one at a time.
 *
 * The breaker (provider-health.ts) answers when, and because firing MOVES its clock, the second stranded
 * conversation on the same provider is refused within this very loop. That is the anti-spam property stated
 * once: an outage costs one turn per window to keep measuring, whether one agent is waiting on it or twenty. The
 * turn that goes is the oldest, which is both the fairest and the one whose user has been waiting longest; and
 * whichever one it is, its SUCCESS clears the breaker for everybody, so the rest follow on the next few passes
 * rather than waiting out a fresh backoff each.
 *
 * The posture is read per pass and PER CONVERSATION, not snapshotted at failure time, arming a stranded turn
 * while it sits here arms that turn, which is what the chat's offer promises. Per conversation because that is
 * what the offer writes (outageResumeArmed): one chat saying "finish this" must not speak for the other
 * nineteen stranded on the same provider. */
const runOutagePass = async (services: Services, wake: WakeFn, now: number): Promise<void> => {
    const stranded = [...pendingOutage.values()];
    if (stranded.length === 0) {
        return;
    }
    for (const failure of stranded) {
        const conversationId = failure.input.conversationId;
        // A turn nobody resumed within the hour is not worth resuming at all: the attempts are spent, or the
        // toggle is off and the offer went unanswered. Either way the user has read the failure and moved on, and
        // a turn springing back to life long after they did is worse than one that stayed dead.
        if (now - failure.recordedAt > OUTAGE_STALE_AFTER_MS) {
            // And the card stops saying it is coming back, for the same reason, see abandonResume. Kept until
            // that lands: an abandon refused by a turn still unwinding is the one way this leaves a spinner
            // behind, and the entry is what brings the pass back to finish the job.
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
        // The breaker's cheap synchronous answer first, the posture's read second, most passes during an
        // outage are inside a wait, and there is no reason to touch the registry or the settings file to
        // establish that. Neither gate spends anything: the window moves at DISPATCH (outageRetryFired below),
        // so a stranded chat that is simply not armed costs the armed ones behind it nothing.
        if (!outageRetryDue(failure.provider, now) || !(await outageResumeArmed(services, conversationId))) {
            continue;
        }
        // Counted at dispatch, before the turn starts: it is what closes the window against the next stranded
        // conversation, and it must hold even if starting this one turns out to conflict.
        outageRetryFired(failure.provider, now);
        // Dropped before firing, like both paths above, a conflict means a live turn already owns this
        // conversation and supersedes the resume, and a retained entry would re-fire on every pass. A resume that
        // dies on the outage AGAIN is re-recorded by its own turn, with the breaker one step further along.
        pendingOutage.delete(conversationId);
        if ((await startConversationTurn(services, wake, resumedTurn(failure, RESUME_NOTES.outage))) !== undefined) {
            services.logger.info({ conversationId, provider: failure.provider, waiting: stranded.length }, "provider-outage auto-resume fired");
        }
    }
};

/* THE LIMIT PASS. Every conversation whose held turn is waiting on an allowance, sent again at the instant the
 * provider said the allowance comes back, and only for the conversations whose owner asked for that.
 *
 * THREE GATES, and each of them is refusing a different kind of wrong.
 *
 * `reopensAt` ABSENT means the failure could not say when the window opens (Grok, Cursor, and anything whose
 * vendor publishes no readable quota). There is nothing to schedule against, so nothing is scheduled: the entry
 * stays exactly what it was, a held turn waiting for a press.
 *
 * `reopensAt` ALREADY PAST AT RECORD TIME is the gate that matters most and the one whose absence would be
 * expensive. A provider that answers with a stale instant, one that has been and gone, would otherwise be read
 * as "the window is open now", so the fire would go immediately, be refused for the same reason, re-record with
 * the same stale instant, and do it again every five seconds for as long as the daemon lived, spending the
 * user's money on the arithmetic. An instant that was not in the future when the refusal happened is not a
 * schedule, and this is where that is said.
 *
 * ARMED is read per pass and PER CONVERSATION, never snapshotted at failure time, so arming a stranded card
 * hours after it stranded arms that card, which is precisely what the card's own offer promises.
 *
 * ONE FIRE PER HOLD. `fired` is stamped at dispatch and the entry is left in place rather than deleted, which
 * is the opposite of the outage pass and deliberate: a press must go on working whatever the automatic attempt
 * did, and `fireLimitResume` is idempotent by construction. A re-refusal records a FRESH entry (new instant,
 * new `recordedAt`, `fired` back to false) from its own turn's exit, so the next window gets its own single
 * attempt and a window that never reopens gets none. */
const runLimitPass = async (services: Services, wake: WakeFn, now: number): Promise<void> => {
    const stranded = [...pendingLimit.values()];
    for (const held of stranded) {
        const conversationId = held.input.conversationId;
        const reopensAt = held.reopensAt;
        if (held.fired || reopensAt === undefined || reopensAt * 1000 > now || reopensAt * 1000 <= held.recordedAt) {
            continue;
        }
        if (!(await limitResumeArmed(services, conversationId))) {
            continue;
        }
        // Stamped before the fire, like the outage pass counts its attempt at dispatch and for the same reason:
        // it has to hold even if starting the turn turns out to conflict with one already running.
        pendingLimit.set(conversationId, { ...held, fired: true });
        if ((await fireLimitResume(services, wake, conversationId)) !== undefined) {
            services.logger.info({ conversationId, reopensAt }, "usage-limit auto-resume fired: the allowance window reopened");
        }
    }
};

// Polls all three pending maps (the restart condition has no map, see resumeInterruptedTurns). An auth resume
// has no gate at all, it is due the moment it is recorded, and it is not the user's budget being spent but the
// daemon's own rotation being undone. An outage resume waits on the shared per-provider breaker instead of on
// any instant of its own, see runOutagePass. A limit resume is the only one with a real appointment to keep,
// and the only one that does nothing at all unless the user armed it.
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

/* WHOSE ACCOUNT A REHYDRATED SESSION IS ON, for the `session` frame the placeholder re-emits. Read off the
 * registry rather than off the journalled turn: the entry holds the account that actually served this
 * conversation (recorded from the live turn's own frame), where the turn holds only what its request asked
 * for, which for an automation or a channel mention is nothing at all. The client binds its session ref to
 * whatever this frame says, so a blank here would let a reattached tab bind the session to its own current
 * pick and then quietly retire it on the next send. */
const sessionAccount = (services: Services, conversationId: string): { account?: string } => {
    const account = services.agents.entry(conversationId)?.account;
    return account === undefined ? {} : { account };
};

/* A TURN THAT WAS WAITING FOR THE USER when the daemon died is still waiting for them after it comes back.
 *
 * Its journal entry carries the raised cards verbatim (`parked`, turn-journal.ts), and this restores them
 * instead of ending the turn `interrupted` and instead of re-running it: nothing unattended runs, no tokens
 * are spent at boot, and the card the user was about to answer is back where it was, live and answerable
 * under its ORIGINAL request ids (so a reopened window's replayed frame and a half-typed answer draft both
 * still point at a waiter that exists).
 *
 * The vehicle is a PLACEHOLDER TURN down the ordinary startConversationTurn road, whose generator, where a
 * provider would be, re-emits the journalled frames and awaits the restored waiters. Running through the
 * normal pump is what makes everything downstream just work with no special cases: the fleet reads `awaiting`
 * and the right attention flag (the frames fold through registry observe), any window attaches and renders
 * the live card, POST /agent/reply finds the waiter, the awaiting push observer fires, the transcript records
 * the turn when it settles, and the re-emitted park frames re-journal through the same frame loop, so a
 * SECOND restart rehydrates again.
 *
 * The answer then hands off to a REAL turn on the journalled session, the user's response folded behind the
 * `answered` resume note, started only after the placeholder's run has fully unwound, because the resumed
 * turn needs the conversation mutex the placeholder still holds. The settlements that end quietly live
 * (a dismissed question, a bare permission deny) end quietly here too: no follow-up starts. */
const rehydrateParkedTurn = async (services: Services, wake: WakeFn, entry: JournalledTurn): Promise<void> => {
    const conversationId = entry.turn.conversationId;
    const cards = entry.parked ?? [];
    const sessionId = entry.sessionId ?? entry.turn.sessionId;
    // The turn the settlement starts, written by the placeholder generator before it returns, read only
    // after its run has completely unwound. A closure, not a return value: the pump owns the generator.
    let followUp: (AgentTurn & { conversationId: string }) | undefined;
    /* The resumed turn: the original turn's identity, the user's answer behind the `answered` note, the
     * journalled session (which holds the partial work the answer continues), and, where the settlement
     * dictates one, the posture it runs in. resumedTurn above is deliberately NOT reused: it repeats the
     * original PROMPT for a turn that must be re-run, and this turn must not be, the answer is the prompt. */
    const resumed = (answer: string, mode?: AgentTurn["permissionMode"]): AgentTurn & { conversationId: string } => ({
        ...entry.turn,
        prompt: withResumeNote(answer, RESUME_NOTES.answered),
        ...(sessionId !== undefined ? { sessionId } : {}),
        ...(mode !== undefined ? { permissionMode: mode } : {}),
    });
    /* THE SETTLEMENT TABLE, how the answered card maps to the turn that runs next. Undefined is the quiet
     * ending and mirrors live behaviour exactly: a dismissed question already ended the turn through the reply
     * route (stopping + stopTurn, restoreRequest carries the conversationId that route needs), and a bare
     * permission deny is the user pulling the plug (the client stops the turn on it, as live). The kind
     * double-check is for the types, restoreRequest guarantees a reply matches its card's kind. */
    const settlementOf = (card: ParkedCard, reply: AgentReply): (AgentTurn & { conversationId: string }) | undefined => {
        if (card.kind === "plan" && reply.kind === "plan") {
            // Approval runs in POST_PLAN_MODE, the posture a live approval sets on the session. Rejection
            // goes back into plan mode with the feedback, the same words the live gate would deny with.
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
                // Feedback is a redirection the turn takes; a bare deny ends it (see the table's note above).
                return feedback === "" ? undefined : resumed(feedback);
            }
            // The allow has no waiting tool call to feed, the process holding it died, so it becomes a
            // one-shot grant the resumed turn's first ask for this tool consumes, and `always` carries the
            // "don't ask again" flavour through to the session rule that click would have written live.
            grantRestoredPermission(conversationId, card.toolName, reply.decision === "always");
            return resumed(`The user allowed ${card.toolName}: run it and continue where the session left off.`);
        }
        return undefined;
    };
    // The card's stand-in reply if the turn dies before the user answers, each the same value its live
    // raiser registers (agent.ts), so an abort reads identically whichever side of a restart it lands on.
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
        /* The registry lifecycle runConversationTurn wraps around a real turn, minus what a turn that runs no
         * tools has no use for (worktree ensure, sync, naming, checkpoint), the resumed turn takes the real
         * road and does all of it at its own start. Placement follows the entry the conversation already owns,
         * the same rule as live. */
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
        // Every frame folds through registry observe on its way out, exactly as runConversationTurn's loop
        // does, it is what lights `awaiting` and the card's attention flag on the fleet.
        const see = (event: AgentEvent): AgentEvent => {
            svc.agents.observe(conversationId, event);
            return event;
        };
        const controller = new AbortController();
        // Stop works on the placeholder like on any turn: the abort settles every waiter with its stand-in,
        // the cards freeze cancelled, and the run unwinds. No steering queue on purpose: /agent/steer answers
        // NOT_FOUND and the client's own "queued for the next turn" fallback applies.
        const unregister = registerTurn(conversationId, { abort: () => controller.abort() });
        try {
            // The session first: it re-binds the conversation to the partial work, and the pump folds it back
            // into the journal entry, without it a second restart would rehydrate a turn with no session.
            if (sessionId !== undefined) {
                yield see({ kind: "session", sessionId, ...sessionAccount(svc, conversationId) });
            }
            // Waiters go up before their frames go out (restoreRequest registers on the wait call), so a reply
            // racing the replay cannot land in the gap and 404.
            const raised = cards.map((card) => ({ card, outcome: restore(card).wait(controller.signal) }));
            for (const { card } of raised) {
                yield see(card);
            }
            const winner = await Promise.race(raised.map(async ({ card, outcome }) => ({ card, ...(await outcome) })));
            // One answer settles the turn; the rest freeze cancelled, the resumed turn re-asks what it still
            // needs. (A turn parked on several cards at once is rare; answering them as one is not a thing a
            // live turn offers either.)
            controller.abort();
            for (const { outcome } of raised) {
                yield see((await outcome).resolved);
            }
            // A resolved frame carrying a reply is the user's own settlement; its absence is the abort's
            // stand-in. Stop, or a dismissal's stop, and nothing follows those.
            if (winner.resolved.reply !== undefined) {
                followUp = settlementOf(winner.card, winner.reply);
                if (followUp !== undefined) {
                    // An approved plan moves the mode the way the live gate does, so an attached window's mode
                    // chip follows the turn out of planning.
                    if (winner.card.kind === "plan" && winner.reply.kind === "plan" && winner.reply.approve) {
                        yield see({ kind: "mode", mode: POST_PLAN_MODE });
                    }
                    // Between this turn's finish and the resumed turn's begin the entry's resting state would
                    // go out, a blink of "Finished" on a card that is about to be running. `resuming` is
                    // exactly that flag, and the resumed turn's own begin is what clears it.
                    svc.agents.markResuming(conversationId);
                }
            }
            yield see({ kind: "done" });
        } finally {
            unregister();
            await svc.agents.finish(conversationId, Date.now());
        }
    };
    // Rehydration is not an attempt, the counter guards re-RUNS that spend tokens, and this spends none. The
    // attempts ride through unchanged so the journal keeps telling the truth about what has been re-run.
    const run = await startConversationTurn(services, placeholder, entry.turn, entry.attempts);
    if (run === undefined) {
        // A live turn already owns the conversation, it supersedes the park, exactly as a hand retry does.
        return;
    }
    services.logger.info({ conversationId, cards: cards.length }, "parked turn rehydrated, its cards are back where they were");
    // The handoff waits out the whole placeholder run (mutex released, finally unwound), detached, a card can
    // sit unanswered for days, and nothing at boot may wait on it.
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

/* THE BOOT PASS, the restart condition. Run once, right after the daemon comes up, before anything else can
 * start a turn on these conversations.
 *
 * Every journal entry that survived to here is a turn or a fire the daemon stopped existing under: the entry is
 * written when the work goes in flight and deleted the moment it reaches ANY settled outcome, so surviving is
 * itself the signal. There is nothing to poll and no window to wait for, the blocker was the daemon being gone,
 * and it is back.
 *
 * Each entry is consumed exactly once, whatever happens to it: the file is rewritten with its attempt spent (or
 * deleted outright) BEFORE the work restarts, so a turn that kills the daemon a second time comes back to a
 * journal that no longer offers it. Getting that order wrong turns one bad turn into a boot loop that spends a
 * turn's worth of tokens per cycle, forever.
 *
 * Failures here are logged and skipped per entry: a boot must not be held hostage by one unresumable turn. */
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
        // An automation's row must say what happened even when nothing re-fires: an interrupted fire that
        // recorded nothing at all reads as "it never fired", which is the one thing it certainly did do. A chat
        // turn needs no equivalent, registry.begin already left `interrupted` on its entry.
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
        /* A turn parked ON THE USER takes its own road, ahead of every gate below, none of them applies.
         * autoResumeOnRestart gates unattended re-runs that spend tokens, and rehydration runs nothing and
         * spends nothing; an unanswered question does not go stale; restoring a card is not an attempt. The
         * entry is NOT cleared or bumped here, the placeholder's own run re-journals the same state through
         * the ordinary frame loop, which is what makes a second restart rehydrate again. */
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
                /* The shipped default is not to spend another turn automatically. That must not mean losing what
                 * the turn had already done: it never settled, so the conversation's record holds nothing of it,
                 * and this journal entry, about to be cleared, is the last thing that names it. Write the turn
                 * down from the provider's own session store, with an honest ending under it, THEN clear. If the
                 * append fails, keep the journal for the next boot instead of converting a transient disk error
                 * into permanent loss.
                 *
                 * The journal's session id, not the registry's: this is the session THIS turn reported, and the
                 * registry entry may still be pointing at the one before it (the id is written onto the entry as
                 * the frame arrives, but a daemon killed in the gap never got to). */
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
            // The attempt is spent on disk BEFORE the turn restarts: this is the write that has to survive the
            // death it guards against.
            await bumpAttempt(services, entry);
            const { conversationId } = entry.turn;
            if ((await startConversationTurn(services, wake, restartTurnOf(entry), entry.attempts + 1)) !== undefined) {
                services.logger.info({ conversationId }, "restart auto-resume fired");
            }
            continue;
        }
        /* An automation re-fires as a FIRE, back through fireAutomation with the trigger inputs it snapshotted,
         * the same road the approve route replays a held wake down. That keeps the overlap guard, the run record
         * and the activity append, and re-reads a prompt the owner may have fixed since.
         *
         * `cleared: "approval"` because this wake was already past the gate when it died, re-holding an approved
         * fire would ask a question the owner has answered. The GUARD still runs, and that is the point: minutes
         * or hours have passed, and whether the work is still wanted is exactly what a guard is for. */
        const automation = await services.automations.get(entry.automationId);
        if (automation === undefined || !automation.enabled) {
            // Consumed rather than left: an entry with no automation behind it can never fire, and keeping it
            // would record a second, entirely fictional "interrupted" run on the next boot.
            await clearJournalled(services, entry);
            services.logger.info({ automation: entry.automationId }, "interrupted fire not resumed, the automation is gone or disabled");
            continue;
        }
        await bumpAttempt(services, entry);
        // Detached, like every other fire: the re-fired wake is a whole agent turn and must not hold up the boot.
        // fireAutomation writes its own fresh journal entry, replacing the one just bumped.
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

// The turn a restart resume runs, resumedTurn's rules exactly (the prompt in full behind the note, the last
// reported session over the one the client sent, `history` only when there is no session to return to), so it
// uses resumedTurn. The journal names the same two things a failure record does under different keys; this is
// only that rename.
const restartTurnOf = (entry: JournalledTurn): AgentTurn & { conversationId: string } =>
    resumedTurn({ input: entry.turn, ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}) }, RESUME_NOTES.restart);

const clearJournalled = async (services: Services, entry: JournalEntry): Promise<void> => {
    const clear =
        entry.kind === "turn" ? services.turnJournal.clearTurn(entry.turn.conversationId) : services.turnJournal.clearFire(entry.automationId);
    await clear.catch((error: unknown) => services.logger.warn({ err: error }, "turn journal: interrupted entry not cleared"));
};

// Spend one resume attempt, in place. A write that fails is treated as the attempt being unspendable, so the
// entry is dropped instead: better one turn that does not come back than one that comes back on every boot.
const bumpAttempt = async (services: Services, entry: JournalEntry): Promise<void> => {
    const next = { ...entry, attempts: entry.attempts + 1 };
    const write = next.kind === "turn" ? services.turnJournal.recordTurn(next) : services.turnJournal.recordFire(next);
    await write.catch(async (error: unknown) => {
        services.logger.warn({ err: error }, "turn journal: attempt not recorded, dropping the entry rather than risking a resume loop");
        await clearJournalled(services, entry);
    });
};
