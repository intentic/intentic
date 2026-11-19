import { sandboxRef } from "@intentic/extension-api";
import { clockOffset } from "../../agent-status/sandboxClock";
import { providerCapacities } from "../providerAccounts";

/* THE CLOCK EVERY ACCOUNT VERDICT IS ASKED AT WHEN ITS CALLER NAMES NONE, and the one thing that moves a verdict nothing
   else moves. A verdict changes with the clock alone (a window resets, a bench ends, a refusal's instant passes), and a
   computed over one judged at `Date.now()` was read once and kept: the composer's send state, the picker's account rows
   and the capacity rail (which handed chatCapacity a bare `Date.now()`) went on drawing a reset pool as spent until some
   reading happened to move them (2026-11-19). Reading `verdictNow()` makes a computed depend on this clock, which ticks at
   the soonest instant a held capacity says the clock alone changes it (`validUntil`), and every minute where none is held
   (a daemon from before capacity, whose next such instant this window does not work out). */

// Against a daemon that sends no `validUntil`: often enough that a reset is drawn within the minute it happens.
const UNJUDGED_TICK_MS = 60_000;
// A moment past the instant, so the tick reads the change rather than the last millisecond before it; never sooner than
// this, so a capacity whose instant has just passed cannot spin the timer.
const GRACE_MS = 1_000;

// Every tick of this clock; what a computed reading verdictNow() depends on.
const ticks = sandboxRef(() => 0);

// The one timer, and the browser-clock instant it fires at. Armed only when somebody reads the clock: no reader, no timer.
let armed: { readonly at: number; readonly timer: ReturnType<typeof setTimeout> } | undefined;

// The next instant the clock alone changes a held capacity, on this browser's clock (a capacity's instants are the
// sandbox's), or a minute from now where none says.
const nextChange = (now: number): number => {
    const instants = Object.values(providerCapacities.value).flatMap((capacity) => (capacity.validUntil === undefined ? [] : [capacity.validUntil + clockOffset.value]));
    const soonest = instants.length === 0 ? now + UNJUDGED_TICK_MS : Math.min(now + UNJUDGED_TICK_MS, ...instants);
    return Math.max(now, soonest) + GRACE_MS;
};

const arm = (now: number): void => {
    const at = nextChange(now);
    // A timer due at or before the next change still stands; one whose instant has passed without firing (a clock that
    // jumped, a frozen tab) is armed again.
    if (armed !== undefined && armed.at > now && armed.at <= at) {
        return;
    }
    clearTimeout(armed?.timer);
    armed = {
        at,
        timer: setTimeout(() => {
            armed = undefined;
            ticks.value += 1;
        }, at - now),
    };
};

/** This browser's clock, read so that a computed asking a verdict at it is asked again when the verdict could move. */
export const verdictNow = (): number => {
    void ticks.value;
    const now = Date.now();
    arm(now);
    return now;
};
