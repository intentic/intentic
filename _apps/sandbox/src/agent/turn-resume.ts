import { type AgentTurn, USAGE_LIMIT_AUTO_RESUME_ENABLED, type UsageWindow } from "@intentic/sandbox-contract";
import { fireAutomation, type WakeFn } from "../automations/scheduler.js";
import { replaceRejectedToken } from "../claude/claude-credentials.js";
import type { Services } from "../composition.js";
import { turnAwaiting, turnFinished } from "../push/notifications.js";
import { openTurnTranscript, recordTurnTranscript } from "../sessions/turn-transcript.js";
import { outageRetryDue, outageRetryFired } from "./provider-health.js";
import type { JournalEntry, JournalledTurn } from "./turn-journal.js";
import { startTurnRun, type TurnRun } from "./turn-runs.js";

/* RE-RUNNING A TURN WHOSE BLOCKER HAS CLEARED — four conditions, one mechanism.
 *
 * Some turns do not fail because the work was wrong. They fail because something underneath them stopped
 * working for a while, and a moment later it works again. Re-running such a turn is not a retry policy, it is
 * the completion of a turn the user already asked for; leaving it dead means every open tab needs a human to
 * type "continue" into it, which is precisely the morning this module exists to prevent.
 *
 * USAGE LIMIT. The Claude subscription's spent allowance. The turn is not broken, it is EARLY, and the reset
 * instant that reopens the window rides on the failure itself. So the daemon remembers every limit-killed
 * conversation turn and, when the build-wide feature gate and per-sandbox setting are both on, a poll re-runs
 * it once its window has reopened. The build gate is currently off; keeping the hit also preserves the explicit
 * resume-on-another-account action.
 *
 * AUTH. The access token the turn snapshotted at spawn stopped being accepted — almost always because a
 * rotation superseded it, which Anthropic answers with "401 OAuth access token has been revoked" on the old
 * one. There is no instant to wait for here: the replacement either exists the moment we ask or the credential
 * is genuinely dead, so this fires immediately rather than through the poll, and it is NOT gated on a setting
 * — a spent allowance is the user's budget to spend, while a rotated token is the daemon's own bookkeeping
 * breaking a turn nobody chose to break.
 *
 * PROVIDER OUTAGE. The model provider itself failed — 500/502/503, a 529 at capacity, a dropped socket — and
 * the harness's own long in-turn retry budget did not outlast it. This one has no instant to wait for AND no
 * credential to repair: nobody can say when the provider comes back, only that asking again is worth something
 * and asking constantly is worth nothing. So the WHEN is owned by a shared per-provider breaker
 * (provider-health.ts) rather than by this map, and the rule here is only which stranded turn gets the one
 * attempt that breaker permits.
 *
 * RESTART. The daemon itself stopped existing under the turn. This one is not remembered in memory at all — the
 * process that would hold the note is the process that died — so it rides the on-disk turn journal, and the
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

// Fired this long after the provider's reset instant, not AT it — a skewed clock or a provider that rounds
// its own instant would otherwise retry into the same closed window and re-fail.
export const RESUME_DELAY_MS = 60_000;

// A pending resume whose reset came and went without the toggle ever coming on is an offer nobody took —
// dropped after a day so the map doesn't hold dead turns for the sandbox's whole life.
const STALE_AFTER_MS = 24 * 60 * 60_000;

/* The same idea for an outage, but an hour rather than a day, because the two waits are nothing alike. A limit
 * reset is a scheduled event the user knows is coming and may well sleep through, so its offer is worth holding
 * overnight. An outage has no known end, and its attempt budget is spent inside forty minutes: past the hour
 * either the provider is still down or the user has read the red line and moved on, and a turn that springs back
 * to life hours after they did is a worse outcome than one that stayed dead. */
const OUTAGE_STALE_AFTER_MS = 60 * 60_000;

/* How old an interrupted turn may be and still be worth re-running at boot. Generous enough to cover the case
 * this is FOR — a long agent run plus a container rebuild — and short enough that a sandbox switched off for the
 * weekend does not come back mid-thought on Monday, acting on a world that has moved on. The clock is the turn's
 * own start, since nothing records when the daemon died. */
const RESUME_MAX_AGE_MS = 6 * 60 * 60_000;

/* How many times a boot may re-run one turn. Exactly once: a turn whose own tool output OOM-kills the daemon
 * would otherwise resurrect it on every boot for the life of the sandbox, and each boot would cost a fresh
 * turn's spend to reach the same crash. The entry is rewritten with the spent attempt BEFORE the resume starts,
 * so the counter survives the death it is guarding against. */
const MAX_RESUME_ATTEMPTS = 1;

export interface LimitHit {
    // The failed turn as the client sent it — re-resolved from scratch at fire time (fresh credentials,
    // fresh worktree state), so nothing perishable is snapshotted here.
    readonly input: AgentTurn & { conversationId: string };
    // The session the failed turn last reported: it may have minted or advanced one before dying, and THAT
    // session holds any partial work the resume should continue from. Absent ⇒ input.sessionId (or none).
    readonly sessionId?: string;
    // When the exhausted window reopens (epoch seconds, provider-reported).
    readonly resetsAt: number;
}

const pending = new Map<string, LimitHit & { readonly recordedAt: number }>();

export const recordLimitHit = (hit: LimitHit, now: number = Date.now()): void => {
    pending.set(hit.input.conversationId, { ...hit, recordedAt: now });
};

// Every turn start clears its conversation's pending resumes — all three kinds. Whatever runs next (the user
// retrying by hand, the scheduler's own fire) supersedes them. A retry that hits the limit AGAIN records a
// fresh entry with the new reset instant, which is what makes the resume self-pacing across consecutive spent
// windows.
export const clearPendingResume = (conversationId: string): void => {
    pending.delete(conversationId);
    pendingAuth.delete(conversationId);
    pendingOutage.delete(conversationId);
};

export const pendingLimitHit = (conversationId: string): LimitHit | undefined => pending.get(conversationId);

export interface AuthFailure {
    readonly input: AgentTurn & { conversationId: string };
    // The session the failed turn last reported — it holds whatever partial work preceded the 401.
    readonly sessionId?: string;
    // The account whose token was refused, and the exact token that was refused. Both are needed: the account
    // says which credential to re-mint, and the token is what the rotation must supersede rather than replay.
    readonly account: string;
    readonly refusedToken: string;
}

const pendingAuth = new Map<string, AuthFailure>();

/* Remember an auth-killed turn for the next scheduler pass. Recorded from the turn's own exit rather than
 * resumed there and then, because the failing run still owns its conversation at that moment — starting the
 * replacement inline would hit turn-runs' conflict and drop the resume on the floor. The poll is a few seconds
 * behind, and the alternative is a tab that stays dead until a human types into it.
 *
 * A turn that is ITSELF a resume (its prompt already carries the note) is not recorded again: a credential
 * that refuses the freshly minted token too is not a transient rotation, and re-running against it forever
 * would be worse than the one red frame that now stands. */
export const recordAuthFailure = (failure: AuthFailure): void => {
    if (failure.input.prompt.startsWith(AUTH_NOTE)) {
        return;
    }
    pendingAuth.set(failure.input.conversationId, failure);
};

export interface OutageFailure {
    readonly input: AgentTurn & { conversationId: string };
    // The session the failed turn last reported — it holds whatever partial work preceded the outage, which for
    // a mid-turn 500 can be most of the work.
    readonly sessionId?: string;
    // Whose outage this was: the breaker's key, so a Claude outage never gates a Codex conversation's resume.
    readonly provider: string;
}

const pendingOutage = new Map<string, OutageFailure & { readonly recordedAt: number }>();

/* Remember a turn the provider killed. Recorded unconditionally — including for a turn that is ITSELF a resume,
 * which is the opposite of the auth rule above and deliberately so: a re-minted token that gets refused again
 * means the credential is dead and retrying is hopeless, whereas a provider that is still down means the outage
 * is simply longer than one attempt, which is the normal case and the reason a backoff exists at all.
 *
 * Recorded whatever the resumeAfterOutage setting says, for the same reason the limit path does: the failure
 * frame tells the client an "available" resume exists, and turning the toggle on right afterwards has to arm
 * exactly the turn that just bounced. What bounds the retrying is the breaker's attempt budget and the staleness
 * sweep below, never this call. */
export const recordOutageFailure = (failure: OutageFailure, now: number = Date.now()): void => {
    pendingOutage.set(failure.input.conversationId, { ...failure, recordedAt: now });
};

export const pendingOutageFailure = (conversationId: string): OutageFailure | undefined => pendingOutage.get(conversationId);

/* The reset instant when the stream itself never named one: the account's persisted usage windows (recorded
 * at every turn end — see claude-usage.ts). The pool that refused the turn is the account's FULLEST one, so
 * its reset is when this wait ends — the same binding-window rule the browser's usage readouts apply. */
export const accountLimitReset = async (services: Services, account: string | undefined): Promise<number | undefined> => {
    if (account === undefined) {
        return undefined;
    }
    const usage = (await services.accountUsage.read())[account];
    return usage?.windows.reduce<UsageWindow | undefined>(
        (worst, window) => (worst === undefined || window.utilization > worst.utilization ? window : worst),
        undefined,
    )?.resetsAt;
};

// Prepended to the resumed turn's prompt — one wording per way a resume starts, so the model knows what
// interrupted it and whether anything about the run has changed. Startswith-checked against ALL of them before
// wrapping, so a resume that dies the same way again (and is re-recorded from its own input) doesn't stack a
// second copy on the next fire, whichever road that fire takes.
const RESUME_NOTE = "The Claude usage limit that interrupted this conversation has reset, and this turn resumed automatically.";
const SWITCH_NOTE = "The Claude usage limit interrupted this conversation, and this turn now resumes on a different account.";
const AUTH_NOTE = "The Claude credential that interrupted this conversation has been renewed, and this turn resumed automatically.";
const OUTAGE_NOTE = "The model provider was briefly unavailable and interrupted this conversation; this turn resumed automatically.";
const RESTART_NOTE = "The sandbox restarted while this turn was running, which stopped it, and this turn resumed automatically once it came back.";

const withResumeNote = (prompt: string, note: string): string =>
    [RESUME_NOTE, SWITCH_NOTE, AUTH_NOTE, OUTAGE_NOTE, RESTART_NOTE].some((known) => prompt.startsWith(known))
        ? prompt
        : `${note} The interrupted request is repeated below — where part of it was already completed in this session, continue from that point instead of starting over.\n\n${prompt}`;

/* The turn a fire runs. The original prompt rides again IN FULL rather than as a bare "continue": whether
 * the CLI persisted the unprocessed user message before the refusal is its own implementation detail, and a
 * resume that guesses wrong there loses the message — repeating it costs at most a duplicate the model reads
 * past. The session override keeps partial work; `history` seeds a FRESH session, so it only rides when there
 * is no session to return to.
 *
 * `account` is the resume-now path (/agent/resume-limit): the same turn pointed at a different connected
 * account of the same provider, whose allowance is not the spent one. The session STILL rides — Claude
 * sessions live in the sandbox's own store, not the account, so the partial work continues under whichever
 * credential serves the resume. */
const resumedTurn = (
    failure: { readonly input: AgentTurn & { conversationId: string }; readonly sessionId?: string },
    note: string,
    account?: string,
): AgentTurn & { conversationId: string } => {
    const sessionId = failure.sessionId ?? failure.input.sessionId;
    const { history, ...rest } = failure.input;
    return {
        ...rest,
        prompt: withResumeNote(failure.input.prompt, note),
        ...(account !== undefined ? { account } : {}),
        ...(sessionId !== undefined ? { sessionId } : history !== undefined ? { history } : {}),
    };
};

export const resumeTurnOf = (hit: LimitHit, account?: string): AgentTurn & { conversationId: string } =>
    resumedTurn(hit, account === undefined ? RESUME_NOTE : SWITCH_NOTE, account);

/* THE one way the daemon starts a conversation's detached turn — POST /agent, the resume-now route, and all four
 * automatic resumes below. Every start needs the same three things and none of them belong at a call site: the
 * two push observers (a turn parking and a turn settling are the moments worth waking a phone for, and
 * notifyIfAway decides whether it actually is), and the journal entry that carries the turn across a daemon
 * death. Copies of that used to sit here and in agent.routes, which is several copies too many for something
 * whose failure mode is a silently unnotified or unresumable turn.
 *
 * Undefined means turn-runs found a live turn already on the conversation, which SUPERSEDES the resume exactly
 * like a hand retry does. `attempts` is how many boots have already re-run this turn; only the boot pass passes
 * it. */
export const startConversationTurn = (
    services: Services,
    wake: WakeFn,
    turn: AgentTurn & { conversationId: string },
    attempts = 0,
): TurnRun | undefined => {
    const { conversationId, prompt } = turn;
    // Start adoption now, then make the pump wait for it before invoking the provider. A first turn opens an
    // empty record; a legacy conversation adopts only its OLD turns.
    const transcriptOpen = openTurnTranscript(services, turn);
    return startTurnRun((input, signal) => wake(services, input, signal), turn, {
        journal: services.turnJournal,
        before: transcriptOpen,
        transcript: (events) => recordTurnTranscript(services, turn, events),
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

/* Re-mint the refused token and re-run the turn it killed. The rotation call is the whole safety argument: it
 * ADOPTS a token another holder already rotated to (the common case — the proactive refresh is usually what
 * refused this turn in the first place), refreshes only when the store still holds the refused one, and
 * records `invalid_grant` as terminal instead of replaying it. So a credential that is genuinely dead answers
 * undefined, no resume fires, and the coded error frame stands with its reconnect affordance — the one case
 * where a human really is required. */
const fireAuthResume = async (services: Services, wake: WakeFn, failure: AuthFailure): Promise<void> => {
    const conversationId = failure.input.conversationId;
    const replacement = await replaceRejectedToken(services.claudeStore, failure.account, failure.refusedToken).catch((error: unknown) => {
        services.logger.warn({ err: error, account: failure.account }, "auth auto-resume could not re-mint the refused token");
        return undefined;
    });
    // Nothing new to run on: the credential is revoked outright, or the store handed back the very token the
    // API just refused — which would fail identically the moment the turn respawned.
    if (replacement === undefined || replacement === failure.refusedToken) {
        return;
    }
    if (startConversationTurn(services, wake, resumedTurn(failure, AUTH_NOTE)) !== undefined) {
        services.logger.info({ conversationId, account: failure.account }, "auth auto-resume fired");
    }
};

/* THE OUTAGE PASS. Every conversation stranded on a provider, in the order they were stranded, offered to the
 * breaker one at a time.
 *
 * The breaker (provider-health.ts) answers when — and because firing MOVES its clock, the second stranded
 * conversation on the same provider is refused within this very loop. That is the anti-spam property stated
 * once: an outage costs one turn per window to keep measuring, whether one agent is waiting on it or twenty. The
 * turn that goes is the oldest, which is both the fairest and the one whose user has been waiting longest; and
 * whichever one it is, its SUCCESS clears the breaker for everybody, so the rest follow on the next few passes
 * rather than waiting out a fresh backoff each.
 *
 * The toggle is read per pass, not snapshotted at failure time — flipping resumeAfterOutage on while a stranded
 * turn sits here arms that turn, which is what the chat's offer promises. */
const runOutagePass = async (services: Services, wake: WakeFn, now: number): Promise<void> => {
    const stranded = [...pendingOutage.values()];
    if (stranded.length === 0) {
        return;
    }
    const { resumeAfterOutage } = await services.sandboxSettings.get();
    for (const failure of stranded) {
        const conversationId = failure.input.conversationId;
        // A turn nobody resumed within the hour is not worth resuming at all: the attempts are spent, or the
        // toggle is off and the offer went unanswered. Either way the user has read the failure and moved on, and
        // a turn springing back to life long after they did is worse than one that stayed dead.
        if (now - failure.recordedAt > OUTAGE_STALE_AFTER_MS) {
            pendingOutage.delete(conversationId);
            continue;
        }
        if (!resumeAfterOutage || !outageRetryDue(failure.provider, now)) {
            continue;
        }
        // Counted at dispatch, before the turn starts: it is what closes the window against the next stranded
        // conversation, and it must hold even if starting this one turns out to conflict.
        outageRetryFired(failure.provider, now);
        // Dropped before firing, like both paths above — a conflict means a live turn already owns this
        // conversation and supersedes the resume, and a retained entry would re-fire on every pass. A resume that
        // dies on the outage AGAIN is re-recorded by its own turn, with the breaker one step further along.
        pendingOutage.delete(conversationId);
        if (startConversationTurn(services, wake, resumedTurn(failure, OUTAGE_NOTE)) !== undefined) {
            services.logger.info({ conversationId, provider: failure.provider, waiting: stranded.length }, "provider-outage auto-resume fired");
        }
    }
};

// Polls all three pending maps (the restart condition has no map — see resumeInterruptedTurns). A limit resume
// waits for its window to reopen (reset + the delay above), the build gate, and the per-sandbox toggle read on
// each pass. While the build gate is off it can only be fired explicitly on another account, and staleness
// eventually drops it. An auth resume has neither gate — it is due the moment it is recorded, and it is not the user's
// budget being spent but the daemon's own rotation being undone. An outage resume waits on the shared
// per-provider breaker instead of on any instant of its own — see runOutagePass.
export const createTurnResumeScheduler = (services: Services, wake: WakeFn, intervalMs = 5_000): TurnResumeScheduler => {
    let timer: NodeJS.Timeout | undefined;

    const tick = async (now: number = Date.now()): Promise<void> => {
        // Snapshotted before the loop: entries are deleted as they fire, and an await inside a live map
        // iteration would also pick up a failure recorded by a turn that is still settling.
        const refused = [...pendingAuth.values()];
        for (const failure of refused) {
            // Deleted before firing, like the limit path: a conflict means a turn is already live on the
            // conversation and supersedes the resume, and a retained entry would re-fire on every pass.
            pendingAuth.delete(failure.input.conversationId);
            await fireAuthResume(services, wake, failure);
        }
        await runOutagePass(services, wake, now);
        const due = [...pending.values()].filter((hit) => now >= hit.resetsAt * 1000 + RESUME_DELAY_MS);
        if (due.length === 0) {
            return;
        }
        const { autoResumeOnLimit } = await services.sandboxSettings.get();
        for (const hit of due) {
            const conversationId = hit.input.conversationId;
            if (!USAGE_LIMIT_AUTO_RESUME_ENABLED || !autoResumeOnLimit) {
                if (now - hit.recordedAt > STALE_AFTER_MS) {
                    pending.delete(conversationId);
                }
                continue;
            }
            // Deleted before firing either way: a CONFLICT means another turn is already live on the
            // conversation, and that turn — which cleared this entry at ITS start under normal ordering —
            // supersedes the resume exactly like a hand retry does.
            pending.delete(conversationId);
            // The same detached-run shape POST /agent starts, push observers included, so every window can
            // attach to the resumed turn and a user away from the keyboard hears how it ended.
            if (startConversationTurn(services, wake, resumeTurnOf(hit)) !== undefined) {
                services.logger.info({ conversationId, resetsAt: hit.resetsAt }, "usage-limit auto-resume fired");
            }
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

/* THE BOOT PASS — the restart condition. Run once, right after the daemon comes up, before anything else can
 * start a turn on these conversations.
 *
 * Every journal entry that survived to here is a turn or a fire the daemon stopped existing under: the entry is
 * written when the work goes in flight and deleted the moment it reaches ANY settled outcome, so surviving is
 * itself the signal. There is nothing to poll and no window to wait for — the blocker was the daemon being gone,
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
        services.logger.warn({ err: error }, "turn journal: unreadable at boot — nothing is resumed");
        return [];
    });
    if (interrupted.length === 0) {
        return;
    }
    const { autoResumeOnRestart } = await services.sandboxSettings.get();
    for (const entry of interrupted) {
        // An automation's row must say what happened even when nothing re-fires: an interrupted fire that
        // recorded nothing at all reads as "it never fired", which is the one thing it certainly did do. A chat
        // turn needs no equivalent — registry.begin already left `interrupted` on its entry.
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
        const spent = entry.attempts >= MAX_RESUME_ATTEMPTS;
        const stale = now - entry.startedAt > RESUME_MAX_AGE_MS;
        if (!autoResumeOnRestart || spent || stale) {
            await clearJournalled(services, entry);
            services.logger.info(
                { entry: entry.kind, spent, stale, autoResumeOnRestart },
                "interrupted turn not resumed — the interruption stands on the record",
            );
            continue;
        }
        if (entry.kind === "turn") {
            // The attempt is spent on disk BEFORE the turn restarts: this is the write that has to survive the
            // death it guards against.
            await bumpAttempt(services, entry);
            const { conversationId } = entry.turn;
            if (startConversationTurn(services, wake, restartTurnOf(entry), entry.attempts + 1) !== undefined) {
                services.logger.info({ conversationId }, "restart auto-resume fired");
            }
            continue;
        }
        /* An automation re-fires as a FIRE, back through fireAutomation with the trigger inputs it snapshotted —
         * the same road the approve route replays a held wake down. That keeps the overlap guard, the run record
         * and the activity append, and re-reads a prompt the owner may have fixed since.
         *
         * `cleared: "approval"` because this wake was already past the gate when it died — re-holding an approved
         * fire would ask a question the owner has answered. The GUARD still runs, and that is the point: minutes
         * or hours have passed, and whether the work is still wanted is exactly what a guard is for. */
        const automation = await services.automations.get(entry.automationId);
        if (automation === undefined || !automation.enabled) {
            // Consumed rather than left: an entry with no automation behind it can never fire, and keeping it
            // would record a second, entirely fictional "interrupted" run on the next boot.
            await clearJournalled(services, entry);
            services.logger.info({ automation: entry.automationId }, "interrupted fire not resumed — the automation is gone or disabled");
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

// The turn a restart resume runs — resumedTurn's rules exactly (the prompt in full behind the note, the last
// reported session over the one the client sent, `history` only when there is no session to return to), so it
// uses resumedTurn. The journal names the same two things a failure record does under different keys; this is
// only that rename.
const restartTurnOf = (entry: JournalledTurn): AgentTurn & { conversationId: string } =>
    resumedTurn({ input: entry.turn, ...(entry.sessionId !== undefined ? { sessionId: entry.sessionId } : {}) }, RESTART_NOTE);

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
        services.logger.warn({ err: error }, "turn journal: attempt not recorded — dropping the entry rather than risking a resume loop");
        await clearJournalled(services, entry);
    });
};
