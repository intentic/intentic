import type { AgentProvider } from "@intentic/sandbox-contract/schemas/agent";
import { NATIVE_PROVIDERS, TRANSLATOR_PROVIDERS } from "@intentic/sandbox-contract/models/provider-specs";
import type { Services } from "../../composition.js";
import { announceCapacity, capacityHeard, providerCapacity } from "./capacity-feed.js";
import { type ServiceabilityDeps, serviceabilities } from "./serviceability.js";
import { onReopenDue } from "./state-log.js";

/* CAPACITY BACK, NOTICED WHEN IT HAPPENS. An account coming back to ready was said (state-log.ts onAccountReopened) only
   when something judged the accounts again: a spawn, the resume pass, or the idle usage refresh every fifteen minutes.
   So a parent waiting on capacity heard of a pool that reopened at a known instant whenever one of those came next
   (2026-10-20). A provider's accounts are judged again here whenever anything the verdict reads changes: at the soonest
   reopen a judgement saw ahead (onReopenDue), when a new usage reading lands for it (headroom onChange), which is where a
   pool read open again shows first, when a refusal of it is filed or settled (providerRefusals onChange), when something
   above this layer says the provider changed (nudgeCapacity: its outage breaker opening or closing), and at the next
   instant the clock alone changes its picture (the capacity's `validUntil`).

   Each judgement is also the provider's capacity (capacity-feed.ts), sent to every window that asked for it, so a window
   draws what the daemon just judged rather than assembling its own picture from reads that arrived apart (2026-11-19).

   A reopen also re-reads the provider's accounts. The rule already reads a window past its reset as lapsed, on both
   sides; the reading says what the new window holds. */

// Readings land in bursts (a sweep reads every account), and one judgement covers all of a provider's accounts.
const JUDGE_SETTLE_MS = 500;
// A moment past the instant itself, so the judgement it wakes reads the change rather than a second short of it.
const VALID_GRACE_MS = 1_000;
// setTimeout's ceiling: an instant further out wakes early, and the judgement it wakes arms the rest.
const LONGEST_TIMER_MS = 2_147_483_647;

export type CapacityWatchDeps = ServiceabilityDeps & Pick<Services, "headroom" | "logger">;

// The watch running in this process, which nudgeCapacity reaches; one per daemon.
let nudge: ((provider: string) => void) | undefined;

/** Says a provider's picture changed for a reason no store announces (its outage breaker), so it is judged again. */
export const nudgeCapacity = (provider: string): void => nudge?.(provider);

/**
 * Says some provider's picture changed where the change cannot say whose: an account connected or removed through the
 * account files every native provider keeps (agent/providers/accounts/account-files.ts). Every provider is judged again,
 * each merged as any judgement is, and only while a window listens (2026-11-19: a just-connected account was judged
 * from its own row until something else moved its provider).
 */
export const nudgeAllCapacity = (): void => {
    if (!capacityHeard()) {
        return;
    }
    for (const provider of new Set<string>([...NATIVE_PROVIDERS, ...TRANSLATOR_PROVIDERS])) {
        nudge?.(provider);
    }
};

/** Judges a provider's accounts again on each event above, merged per provider; answers the unsubscribe of every one. */
export const watchCapacity = (deps: CapacityWatchDeps): (() => void) => {
    const pending = new Map<string, NodeJS.Timeout>();
    const expiring = new Map<string, { readonly at: number; readonly timer: NodeJS.Timeout }>();
    // One timer per provider, at the instant its last capacity said the clock alone would change it.
    const expireAt = (provider: string, at: number | undefined): void => {
        const current = expiring.get(provider);
        if (current?.at === at) {
            return;
        }
        clearTimeout(current?.timer);
        expiring.delete(provider);
        if (at === undefined) {
            return;
        }
        const timer = setTimeout(
            () => {
                expiring.delete(provider);
                judge(provider);
            },
            Math.min(LONGEST_TIMER_MS, Math.max(0, at - Date.now()) + VALID_GRACE_MS),
        );
        timer.unref();
        expiring.set(provider, { at, timer });
    };
    // Assembled only while a window listens: nothing else reads it, and the daemon's own reopens arm their own timers
    // (state-log.ts onReopenDue). A window that starts listening is sent each provider's capacity and nudges it here
    // (system.routes.ts), which arms the provider's timer from then on.
    const publish = async (provider: AgentProvider): Promise<void> => {
        if (!capacityHeard()) {
            expireAt(provider, undefined);
            return;
        }
        const capacity = await providerCapacity(deps, provider);
        expireAt(provider, capacity.validUntil);
        announceCapacity(capacity);
    };
    const judge = (provider: string): void => {
        if (pending.has(provider)) {
            return;
        }
        const timer = setTimeout(() => {
            pending.delete(provider);
            // SAFETY: a provider name only ever reaches here from a judgement or a reading of that provider's own accounts.
            const named = provider as AgentProvider;
            Promise.all([serviceabilities(deps, named), publish(named)]).catch((error: Error) =>
                deps.logger.warn({ err: error, provider }, "capacity: the accounts could not be judged again, the next reading or page load tries"),
            );
        }, JUDGE_SETTLE_MS);
        timer.unref();
        pending.set(provider, timer);
    };
    const reread = (provider: string): void => {
        // SAFETY: a provider name only ever reaches here from a judgement of that provider's own accounts.
        deps.headroom.refresh({ scope: { providers: [provider as AgentProvider] }, maxAgeMs: 0 }).catch((error: Error) =>
            deps.logger.warn({ err: error, provider }, "capacity: the accounts could not be re-read at their reopen, the next trigger tries"),
        );
    };
    const reopened = (provider: string): void => {
        judge(provider);
        reread(provider);
    };
    nudge = judge;
    const unsubscribes = [onReopenDue(reopened), deps.headroom.onChange((provider) => judge(provider)), deps.providerRefusals.onChange((provider) => judge(provider))];
    return () => {
        if (nudge === judge) {
            nudge = undefined;
        }
        for (const unsubscribe of unsubscribes) {
            unsubscribe();
        }
        for (const timer of [...pending.values(), ...[...expiring.values()].map((entry) => entry.timer)]) {
            clearTimeout(timer);
        }
        pending.clear();
        expiring.clear();
    };
};
