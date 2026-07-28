import type { AgentTurn, UsageWindow } from "@intentic/sandbox-contract";
import type { WakeFn } from "../automations/scheduler.js";
import type { Services } from "../composition.js";
import { turnAwaiting, turnFinished } from "../push/notifications.js";
import { startTurnRun } from "./turn-runs.js";

/* Auto-resume after a usage-limit failure. A turn that dies on the Claude subscription's spent allowance is
 * not broken — it is EARLY, and the reset instant that reopens the window is on the failure itself. So the
 * daemon remembers every limit-killed conversation turn here (whatever the autoResumeOnLimit setting says —
 * enabling the toggle right after a failure must arm the resume that failure already offered), and a poll
 * re-runs each one as an ordinary detached run once its window has reopened. Daemon-side on purpose: the
 * whole point of detached runs is that turns outlive browser tabs, and a resume timer that dies with the tab
 * would miss exactly the resets worth automating (a 5-hour window lapsing overnight).
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

// Every turn start clears its conversation's pending resume: whatever runs next — the user retrying by hand,
// the scheduler's own fire — supersedes it. A retry that hits the limit AGAIN records a fresh entry with the
// new reset instant, which is what makes the resume self-pacing across consecutive spent windows.
export const clearLimitHit = (conversationId: string): void => {
    pending.delete(conversationId);
};

export const pendingLimitHit = (conversationId: string): LimitHit | undefined => pending.get(conversationId);

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

// Prepended to the resumed turn's prompt. Startswith-checked before wrapping so a resume that ALSO dies on
// the limit (and is re-recorded from its own input) doesn't stack a second copy on the next fire.
const RESUME_NOTE = "The Claude usage limit that interrupted this conversation has reset, and this turn resumed automatically.";

const withResumeNote = (prompt: string): string =>
    prompt.startsWith(RESUME_NOTE)
        ? prompt
        : `${RESUME_NOTE} The interrupted request is repeated below — where part of it was already completed in this session, continue from that point instead of starting over.\n\n${prompt}`;

/* The turn a fire runs. The original prompt rides again IN FULL rather than as a bare "continue": whether
 * the CLI persisted the unprocessed user message before the refusal is its own implementation detail, and a
 * resume that guesses wrong there loses the message — repeating it costs at most a duplicate the model reads
 * past. The session override keeps partial work; `history` seeds a FRESH session, so it only rides when there
 * is no session to return to. */
export const resumeTurnOf = (hit: LimitHit): AgentTurn & { conversationId: string } => {
    const sessionId = hit.sessionId ?? hit.input.sessionId;
    const { history, ...rest } = hit.input;
    return {
        ...rest,
        prompt: withResumeNote(hit.input.prompt),
        ...(sessionId !== undefined ? { sessionId } : history !== undefined ? { history } : {}),
    };
};

export interface LimitResumeScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass; `start` runs it on an interval. Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
}

// Polls the pending map and re-runs whatever window has reopened (reset + the delay above). The toggle is
// read per pass, not snapshotted at failure time: flipping it on while a reset is pending arms that resume,
// and a reset that arrives with the toggle off simply waits for it (until staleness drops the entry).
export const createLimitResumeScheduler = (services: Services, wake: WakeFn, intervalMs = 30_000): LimitResumeScheduler => {
    let timer: NodeJS.Timeout | undefined;

    const tick = async (now: number = Date.now()): Promise<void> => {
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
