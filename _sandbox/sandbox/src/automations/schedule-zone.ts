import { asZone, cronOptions, UTC, type Zone } from "@intentic/sandbox-contract/time/zone";
import { Cron } from "croner";
import type { Services } from "../composition.js";
import type { AutomationRecord } from "./automations-store.js";

// WHICH CLOCK A CRON IS READ ON. The daemon's container runs UTC and the person who typed "20:43" almost never does,
// so every croner call in this tree goes through one of these two rather than letting the process's own zone answer by
// default — which is what it does for a bare `new Cron(expr)`, silently, with a plausible-looking result. And, read on
// that clock, when the schedules next come due, with the timer that fires them on the moment (below).

/**
 * The sandbox's zone of record. UTC when nobody has set one, which is a real answer rather than a guess: a sandbox
 * whose owner has never said where they are has no better information, and every screen that shows a schedule says
 * which clock it is on, so the owner can see the assumption instead of discovering it two hours late.
 */
export const sandboxZone = async (services: Pick<Services, "sandboxSettings">): Promise<Zone> => asZone((await services.sandboxSettings.get()).timezone) ?? UTC;

/**
 * The clock one automation's cron is meant on: its own override first, the sandbox's setting behind it. An id the
 * schema let through but ICU no longer knows (a zone retired between two releases) falls back rather than throwing —
 * an automation with a stale zone should fire an hour out, not take the tick down with it.
 */
export const zoneOf = (trigger: { readonly tz?: string | undefined }, sandbox: Zone): Zone => asZone(trigger.tz) ?? sandbox;

/* ON THE MOMENT (2026-10-18). The scheduler's poll alone fires a schedule up to one poll late, and a sandbox its
   computer's keeper woke ahead of its alarm (ic's `sandbox wakes`) is up precisely so the schedule fires on its minute.
   So every pass of a started scheduler also sets one timer for the soonest moment due within a poll, which runs a pass
   the moment it comes; one due further out is left to a later pass, which sets it closer. The first pass comes a poll
   after the start, well inside the alarm's lead of two minutes or more, so a woken sandbox has its timer set in time.
   The timer is only ever early by the clock's own jitter, and then waits out the rest. The timer itself is now the
   scheduler's pass's own (workload/nudged-pass.ts, 2026-10-20), which a turn settling or a save also wakes. */

// The soonest moment after `after` that an enabled automation's own clock comes due (a cron's next run, a one-time wake
// not yet passed), for the timer that fires it on the moment rather than at the next poll; undefined for none. An
// invalid cron has no moment, as everywhere else. Pure.
export const nextDueAfter = (automations: readonly AutomationRecord[], after: number, sandbox: Zone): number | undefined => {
    const moments = automations.flatMap((automation): number[] => {
        if (!automation.enabled) {
            return [];
        }
        if (automation.trigger.kind === "once") {
            return automation.trigger.at > after ? [automation.trigger.at] : [];
        }
        if (automation.trigger.kind !== "schedule") {
            return [];
        }
        try {
            const due = new Cron(automation.trigger.cron, cronOptions(zoneOf(automation.trigger, sandbox))).nextRun(new Date(after));
            return due === null ? [] : [due.getTime()];
        } catch {
            // allow(silent-catch): an invalid cron silences only its own automation, never the timer.
            return [];
        }
    });
    return moments.length === 0 ? undefined : Math.min(...moments);
};

// When this automation is next due, or undefined for one no clock drives (a webhook, a listener, a workspace event)
// and one switched off. An invalid cron can only come from a hand-edited manifest — upsert rejects it — and reads as
// no next run rather than failing whatever asked.
// A one-time wake answers its own moment even once that moment is past: the tick fires an overdue one rather than
// dropping it, so "due" stays the truth right up until it fires.
// `sandbox` is the zone of record the automation's own `tz` overrides; it is a parameter rather than a read, so this
// stays pure and every caller has to have decided which clock it means.
export const nextRunOf = (automation: AutomationRecord, sandbox: Zone): number | undefined => {
    if (!automation.enabled) {
        return undefined;
    }
    if (automation.trigger.kind === "once") {
        return automation.trigger.at;
    }
    if (automation.trigger.kind !== "schedule") {
        return undefined;
    }
    try {
        return new Cron(automation.trigger.cron, cronOptions(zoneOf(automation.trigger, sandbox))).nextRun()?.getTime();
    } catch {
        // allow(silent-catch): a cron that doesn't parse has no next run.
        return undefined;
    }
};
