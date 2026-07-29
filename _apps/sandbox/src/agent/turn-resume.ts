import type { AgentTurn, UsageWindow } from "@intentic/sandbox-contract";
import type { WakeFn } from "../automations/scheduler.js";
import { replaceRejectedToken } from "../claude/claude-credentials.js";
import type { Services } from "../composition.js";
import { turnAwaiting, turnFinished } from "../push/notifications.js";
import { startTurnRun } from "./turn-runs.js";

/* RE-RUNNING A TURN WHOSE BLOCKER HAS CLEARED — two conditions, one mechanism.
 *
 * Some turns do not fail because the work was wrong. They fail because the credential underneath them stopped
 * working for a while, and a moment later it works again. Re-running such a turn is not a retry policy, it is
 * the completion of a turn the user already asked for; leaving it dead means every open tab needs a human to
 * type "continue" into it, which is precisely the morning this module exists to prevent.
 *
 * USAGE LIMIT. The Claude subscription's spent allowance. The turn is not broken, it is EARLY, and the reset
 * instant that reopens the window rides on the failure itself. So the daemon remembers every limit-killed
 * conversation turn (whatever the autoResumeOnLimit setting says — enabling the toggle right after a failure
 * must arm the resume that failure already offered) and a poll re-runs it once its window has reopened.
 *
 * AUTH. The access token the turn snapshotted at spawn stopped being accepted — almost always because a
 * rotation superseded it, which Anthropic answers with "401 OAuth access token has been revoked" on the old
 * one. There is no instant to wait for here: the replacement either exists the moment we ask or the credential
 * is genuinely dead, so this fires immediately rather than through the poll, and it is NOT gated on a setting
 * — a spent allowance is the user's budget to spend, while a rotated token is the daemon's own bookkeeping
 * breaking a turn nobody chose to break.
 *
 * Daemon-side on purpose, both of them: the whole point of detached runs is that turns outlive browser tabs,
 * and a resume that died with the tab would miss exactly the failures worth automating (a 5-hour window
 * lapsing overnight; a token rotating while the operator is away).
 *
 * Keyed by conversationId, like turn-runs: one pending resume per conversation, and any NEW turn on the
 * conversation supersedes it (the user retrying by hand must not be doubled by the scheduler). */

// Fired this long after the provider's reset instant, not AT it — a skewed clock or a provider that rounds
// its own instant would otherwise retry into the same closed window and re-fail.
export const RESUME_DELAY_MS = 60_000;

// A pending resume whose reset came and went without the toggle ever coming on is an offer nobody took —
// dropped after a day so the map doesn't hold dead turns for the sandbox's whole life.
const STALE_AFTER_MS = 24 * 60 * 60_000;

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

// Every turn start clears its conversation's pending resumes — both kinds. Whatever runs next (the user
// retrying by hand, the scheduler's own fire) supersedes them. A retry that hits the limit AGAIN records a
// fresh entry with the new reset instant, which is what makes the resume self-pacing across consecutive spent
// windows.
export const clearPendingResume = (conversationId: string): void => {
    pending.delete(conversationId);
    pendingAuth.delete(conversationId);
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

/* The reset instant when the stream itself never named one: the account's persisted usage windows (recorded
 * at every turn end — see claude-usage.ts). The pool that refused the turn is the account's FULLEST one, so
 * its reset is when this wait ends — the same binding-window rule the browser's usage readouts apply. */
export const accountLimitReset = async (services: Services, account: string | undefined): Promise<number | undefined> => {
    if (account === undefined) {
        return undefined;
    }
    const usage = (await services.claudeUsage.read())[account];
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

const withResumeNote = (prompt: string, note: string): string =>
    [RESUME_NOTE, SWITCH_NOTE, AUTH_NOTE].some((known) => prompt.startsWith(known))
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
export const resumeTurnOf = (hit: LimitHit, account?: string): AgentTurn & { conversationId: string } => {
    const sessionId = hit.sessionId ?? hit.input.sessionId;
    const { history, ...rest } = hit.input;
    return {
        ...rest,
        prompt: withResumeNote(hit.input.prompt, account === undefined ? RESUME_NOTE : SWITCH_NOTE),
        ...(account !== undefined ? { account } : {}),
        ...(sessionId !== undefined ? { sessionId } : history !== undefined ? { history } : {}),
    };
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
    const sessionId = failure.sessionId ?? failure.input.sessionId;
    const { history, ...rest } = failure.input;
    const turn: AgentTurn & { conversationId: string } = {
        ...rest,
        prompt: withResumeNote(failure.input.prompt, AUTH_NOTE),
        ...(sessionId !== undefined ? { sessionId } : history !== undefined ? { history } : {}),
    };
    const run = startTurnRun((input, signal) => wake(services, input, signal), turn, {
        awaiting: (kind) => void services.pushSender.notifyIfAway(turnAwaiting(conversationId, kind)),
        settled: (outcome) => void services.pushSender.notifyIfAway(turnFinished(conversationId, turn.prompt, outcome)),
    });
    if (run !== undefined) {
        services.logger.info({ conversationId, account: failure.account }, "auth auto-resume fired");
    }
};

// Polls both pending maps. A limit resume waits for its window to reopen (reset + the delay above) and for the
// toggle, read per pass rather than snapshotted at failure time: flipping it on while a reset is pending arms
// that resume, and a reset that arrives with the toggle off simply waits for it (until staleness drops the
// entry). An auth resume has neither gate — it is due the moment it is recorded, and it is not the user's
// budget being spent but the daemon's own rotation being undone.
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
        const due = [...pending.values()].filter((hit) => now >= hit.resetsAt * 1000 + RESUME_DELAY_MS);
        if (due.length === 0) {
            return;
        }
        const { autoResumeOnLimit } = await services.sandboxSettings.get();
        for (const hit of due) {
            const conversationId = hit.input.conversationId;
            if (!autoResumeOnLimit) {
                if (now - hit.recordedAt > STALE_AFTER_MS) {
                    pending.delete(conversationId);
                }
                continue;
            }
            // Deleted before firing either way: a CONFLICT means another turn is already live on the
            // conversation, and that turn — which cleared this entry at ITS start under normal ordering —
            // supersedes the resume exactly like a hand retry does.
            pending.delete(conversationId);
            const turn = resumeTurnOf(hit);
            // The same detached-run shape POST /agent starts, push observers included, so every window can
            // attach to the resumed turn and a user away from the keyboard hears how it ended.
            const run = startTurnRun((input, signal) => wake(services, input, signal), turn, {
                awaiting: (kind) => void services.pushSender.notifyIfAway(turnAwaiting(conversationId, kind)),
                settled: (outcome) => void services.pushSender.notifyIfAway(turnFinished(conversationId, turn.prompt, outcome)),
            });
            if (run !== undefined) {
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
