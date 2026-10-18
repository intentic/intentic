import { nextBookedSendAt } from "../agent/run/turn/turn-resume.js";
import { nextApprovedAt } from "../approvals/approvals-executor.js";
import { nextCountdownWakeAt, nextCronWakeAt, nextOneTimeWakeAt } from "../automations/scheduler.js";
import type { Services } from "../composition.js";

// WHAT THE SANDBOX PROMISED FOR LATER, ONE LIST (2026-10-12). Four clocks in this daemon each start something on a moment
// somebody was promised: the automations tick (a one-time wake, a cron, a held wake's countdown), the held-turn pass and the conversations' bookings
// (a person's scheduled send, a spent allowance's resend at its reset), and the approvals executor (an approved post at its
// date). Two places summed them by hand, idle-stop's and the automatic update's, and the approvals executor was in neither,
// so a sandbox could stop for idleness minutes before an approved post was due and post it whenever somebody next visited.
// A clock that promises a moment is added HERE, with a reader its own module owns, and both consumers see it.
//
// Armed watches (agent/verification/watchers.ts) are not on this list: a watch has no moment, it polls, so it is work in
// flight rather than a promise (bootstrap/working-now.ts holds the machine for as long as one is armed).

// - idle-stop: a promise due within NOT_WORTH_SLEEPING_MS holds the hosted machine up; a later one is saved as the
//   platform's durable alarm before it stops (system/sleep/idle-stop.ts, hosted-sleep.ts).
// - restart: this container restarts for an automatic update, and waits for a quiet moment before a promised one.
// - sleep: the computer this sandbox runs on puts it to sleep and sets an alarm for the soonest of these, started again
//   ahead of it (ic's `sandbox sleep` and `sandbox wakes`, 2026-10-18), read off the work signal's `nextWakeAt`.
export type WakePurpose = "idle-stop" | "restart" | "sleep";

export interface PromisedWake {
    readonly name: string;
    // Which questions this wake answers. A difference between purposes is stated here, in one place, so it is a decision.
    readonly holds: readonly WakePurpose[];
    // The moment of the soonest one (ms), or undefined for none.
    readonly nextAt: (services: Services) => Promise<number | undefined>;
}

const EVERY: readonly WakePurpose[] = ["idle-stop", "restart", "sleep"];

// The readers that answer 0 for none (the automations' and the bookings') are read as the numbers they are.
const instant = async (read: Promise<number>): Promise<number | undefined> => {
    const at = await read;
    return at > 0 ? at : undefined;
};

export const PROMISED_WAKES: readonly PromisedWake[] = [
    { name: "a one-time automation", holds: EVERY, nextAt: (services) => instant(nextOneTimeWakeAt(services)) },
    {
        name: "a scheduled message, or a held turn booked for its allowance's reset",
        holds: EVERY,
        nextAt: (services) => instant(nextBookedSendAt(services)),
    },
    { name: "an approved post or action", holds: EVERY, nextAt: (services) => nextApprovedAt(services) },
    { name: "a held automation wake counting down", holds: EVERY, nextAt: (services) => instant(nextCountdownWakeAt(services)) },
    { name: "a cron automation", holds: EVERY, nextAt: (services) => instant(nextCronWakeAt(services)) },
];

/** The soonest moment of `purpose` anything promised (ms), or undefined when nothing is. */
export const nextPromisedWake = async (services: Services, purpose: WakePurpose): Promise<number | undefined> => {
    const asked = PROMISED_WAKES.filter((wake) => wake.holds.includes(purpose));
    const moments = (await Promise.all(asked.map((wake) => wake.nextAt(services)))).filter((at): at is number => at !== undefined);
    return moments.length === 0 ? undefined : Math.min(...moments);
};
