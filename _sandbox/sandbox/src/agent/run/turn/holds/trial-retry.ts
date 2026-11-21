import { isTrialProvider } from "@intentic/sandbox-contract/models/agent-catalog";
import { withRuntimeDefaults } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../../../composition.js";
import { type QueuedItem, waitingOf } from "../../../../conversations/actor/conversation-queue.js";
import type { Ending } from "../../../../conversations/registry/agents-store.js";
import type { DueAt } from "../../../../workload/nudged-pass.js";
import { releaseAccountHolds } from "./account-refusal-release.js";

/* A FIRST MESSAGE THE FREE TRIAL TURNED AWAY AS BUSY IS SENT AGAIN BY ITSELF, A FEW TIMES, VISIBLY. `trial-unavailable`
   means the platform's whole free pool refused at that moment (every rung of its ladder, every healthy key): a refusal a
   minute's wait usually clears. Its words went back to the queue held for a press (turn-admission.ts handBack), and the
   person, on a hosted sandbox with no model of their own, re-picked the same trial or left: PostHog, 2026-11, ten of 31
   first messages refused this way, none of those people back the next day. The resume pass now books those words to go
   again on a short bounded backoff, as an ordinary booking every window draws (`trialRetry` on the queued message says
   it is the sandbox's retry, and which try), so the booked release sends them (booked-release.ts) and a refusal hands
   them back for the next try. A person's own word ends it: a message sent after them, a pick that moves them, a re-time,
   a take-back (conversation-queue.ts). (2026-11-21) Rejected: retrying in the window, which a closed tab ends and two
   tabs double; and a rung on the held turn, which a person's words are not (they wait in the queue, not as a held turn). */

// The wait before each automatic try, ms: about two and a half minutes over three tries, inside which a pool quarantine
// (10-30 s per key, a 429's Retry-After) usually lapses. Past them the words wait for a press, as before.
const TRIAL_RETRY_DELAYS_MS = [20_000, 45_000, 90_000] as const;
export const TRIAL_RETRY_MAX = TRIAL_RETRY_DELAYS_MS.length;
// A retry instant the platform names (the pool's soonest quarantine end) is waited for, but never past this.
const LONGEST_WAIT_MS = 120_000;
// How long the pass waits on the platform's status for that instant before booking on its own backoff.
const STATUS_WITHIN_MS = 2_000;

// The ending the pool's refusal leaves; the route's own (no trial endpoint, no translator) is excluded below.
const trialBusy = (ending: Ending | undefined): boolean => ending?.kind === "failed" && ending.code === "trial-unavailable";

// Which try the next one would be, counting on from the words' own: the highest any of them has had.
const triesMade = (words: readonly QueuedItem[]): number => Math.max(0, ...words.map((item) => item.trialRetry?.made ?? 0));

/** When the next automatic try goes (ms): its step of the backoff, or the platform's own retry instant if later. */
export const trialRetryAt = (made: number, now: number, platformRetryAt: number | undefined): number | undefined => {
    const step = TRIAL_RETRY_DELAYS_MS[made];
    if (step === undefined) {
        return undefined;
    }
    const own = now + step;
    return platformRetryAt === undefined || platformRetryAt <= own ? own : Math.min(platformRetryAt, now + LONGEST_WAIT_MS);
};

// The pool's retry instant as the platform last said it (ms), asked again briefly: a reading it cannot give costs only it.
const platformRetryAt = async (services: Pick<Services, "trial">): Promise<number | undefined> => {
    await services.trial.refresh({ withinMs: STATUS_WITHIN_MS });
    const stamp = services.trial.status()?.retryAt;
    const at = stamp === undefined ? Number.NaN : Date.parse(stamp);
    return Number.isNaN(at) ? undefined : at;
};

/**
 * Books the words the free trial turned away as busy to go again by themselves, in every conversation where they still go
 * on the trial and tries are left. Spent, or with the trial gone from this sandbox, they wait for a press.
 */
export const retryTrialHolds = async (services: Services, now: number, due?: DueAt): Promise<void> => {
    for (const { conversationId } of services.conversations.refused()) {
        if (!trialBusy(services.agents.entry(conversationId)?.ending)) {
            continue;
        }
        const words = waitingOf(services.conversations.queued(conversationId)).filter((item) => item.voice === "person");
        // Moved to another model (a pick), or the sandbox's or an agent's words: theirs is not the trial's refusal to retry.
        if (words.length === 0 || !words.every((item) => isTrialProvider(withRuntimeDefaults(item.turn).agent))) {
            continue;
        }
        // The trial's own route gone (resolveTrialRoute says so with the same code): another try is refused at once.
        if (!services.trial.available() || services.config.translator.url === "") {
            continue;
        }
        const made = triesMade(words);
        const until = trialRetryAt(made, now, made >= TRIAL_RETRY_MAX ? undefined : await platformRetryAt(services));
        if (until === undefined) {
            continue;
        }
        const ids = words.map((item) => item.id);
        const trialRetry = { made: made + 1, max: TRIAL_RETRY_MAX };
        services.conversations.send(conversationId, { kind: "queue-rescheduled", booking: { until, trialRetry }, ids }, now);
        due?.(until);
        services.logger.info(
            { conversationId, messages: ids.length, try: trialRetry.made, of: TRIAL_RETRY_MAX, until: new Date(until).toISOString() },
            "resume pass: the free trial turned these words away as busy, they go again by themselves",
        );
    }
};

/**
 * The resume pass's step for a person's words a refusal at the door handed back: an account's refusal let go once the
 * provider can serve them (account-refusal-release.ts), the trial's booked to go again. Each on its own, so one that
 * throws leaves the other to run, and the next pass tries again.
 */
export const releaseRefusedWords = async (services: Services, now: number, due: DueAt): Promise<void> => {
    try {
        await releaseAccountHolds(services, now);
    } catch (error) {
        services.logger.error({ err: error }, "resume pass: an account refusal's words could not be let go, the next pass tries again");
    }
    try {
        await retryTrialHolds(services, now, due);
    } catch (error) {
        services.logger.error({ err: error }, "resume pass: words the free trial turned away could not be booked to go again, the next pass tries again");
    }
};
