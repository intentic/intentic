import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import type { Services } from "../../composition.js";
import { type ServiceabilityDeps, serviceabilities } from "./serviceability.js";
import { onReopenDue } from "./state-log.js";

/* CAPACITY BACK, NOTICED WHEN IT HAPPENS. An account coming back to ready was said (state-log.ts onAccountReopened) only
   when something judged the accounts again: a page load, a spawn, the resume pass, or the idle usage refresh every
   fifteen minutes. So a parent waiting on capacity heard of a pool that reopened at a known instant whenever one of those
   came next (2026-10-20). A provider's accounts are judged again here at the soonest reopen a judgement saw ahead
   (onReopenDue), and whenever a new usage reading lands for it (headroom onChange), which is where a pool read open
   again shows first. */

// Readings land in bursts (a sweep reads every account), and one judgement covers all of a provider's accounts.
const JUDGE_SETTLE_MS = 500;

export type CapacityWatchDeps = ServiceabilityDeps & Pick<Services, "headroom" | "logger">;

/** Judges a provider's accounts again on each event above, merged per provider; answers the unsubscribe of both. */
export const watchCapacity = (deps: CapacityWatchDeps): (() => void) => {
    const pending = new Map<string, NodeJS.Timeout>();
    const judge = (provider: string): void => {
        if (pending.has(provider)) {
            return;
        }
        const timer = setTimeout(() => {
            pending.delete(provider);
            // SAFETY: a provider name only ever reaches here from a judgement or a reading of that provider's own accounts.
            serviceabilities(deps, provider as AgentProvider).catch((error: Error) =>
                deps.logger.warn({ err: error, provider }, "capacity: the accounts could not be judged again, the next reading or page load tries"),
            );
        }, JUDGE_SETTLE_MS);
        timer.unref();
        pending.set(provider, timer);
    };
    const unsubscribes = [onReopenDue(judge), deps.headroom.onChange((provider) => judge(provider))];
    return () => {
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
        for (const timer of pending.values()) {
            clearTimeout(timer);
        }
        pending.clear();
    };
};
