// NIGHT HOURS: the hours the owner sleeps, set on purpose, during which an agent that would stop to ask them something
// carries on instead. A turn left running for the night used to park on its first question until morning, and the
// owner woke to a question rather than to work.
//
// Read on the sandbox's own clock (`timezone`, the zone every wall-clock rule here is meant in), and only in force while
// nobody is at the editor: someone up past their night's start and at a screen is asked as on any other evening.
//
// A night can also be begun by hand (`asleepSince`, the Agents board's moon), for an evening the owner goes to bed
// early: from that press to the next `to` it is night as surely as inside the window, the editor rule included.

import { z } from "zod";
import { civilDayIn, nextDayStartIn, wallClockInstant, type Zone } from "../time/zone.js";

/** A time of day on a wall clock, as `HH:MM` from 00:00 to 23:59. */
export const ClockTimeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "A time of day as HH:MM, 00:00 to 23:59.");
export type ClockTime = z.infer<typeof ClockTimeSchema>;

// What a question an agent asks during night hours gets. `decide`: the sandbox answers it with the option the agent
// recommends, and the agent lists what was decided for the owner in its last message. `defer`: the sandbox tells the
// agent the question waits for the morning, and the agent finishes everything that does not hang on it, then ends with
// the question.
export const NightQuestionsSchema = z.enum(["decide", "defer"]);
export type NightQuestions = z.infer<typeof NightQuestionsSchema>;

export const NightHoursSchema = z.object({
    on: z
        .boolean()
        .default(false)
        .describe("Whether the night comes by itself, every day at these hours. Off, every question waits for an answer, whatever the hour, except on a night you begin by hand (`asleepSince`)."),
    from: ClockTimeSchema.default("23:00").describe("When the night begins, as HH:MM on the sandbox's clock."),
    to: ClockTimeSchema.default("07:00").describe(
        "When it ends, as HH:MM on the sandbox's clock: also the morning that ends a night begun by hand. Earlier than `from` runs past midnight; equal to it is no night at all.",
    ),
    questions: NightQuestionsSchema.default("decide").describe(
        "What a question an agent asks during night hours, with nobody at the editor, gets. `decide`: it is answered with the option the agent recommends, and the agent lists what was decided for you in its last message, so you can overturn any of it. `defer`: the agent is told it waits for the morning, finishes everything that does not depend on the answer, and ends with the question at the top of its last message.",
    ),
    // A night begun by hand (the board's moon): the owner going to bed before their hours begin, or on a day they keep
    // none. It lasts until the next `to`, so it ends by itself in the morning and nothing has to remember to clear it.
    asleepSince: z
        .number()
        .int()
        .nonnegative()
        .optional()
        .describe(
            "When you said good night by hand, in milliseconds since the epoch. From then until the next `to` on the sandbox's clock it is night, whether or not night hours are on and whatever `from` says. Absent, or once that morning has come, only the hours count.",
        ),
});
export type NightHours = z.infer<typeof NightHoursSchema>;

const minutesOf = (time: ClockTime): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));

// The minute of the day a named clock shows at an instant. `h23`, since `hour12: false` reads midnight as 24 in some
// engines.
const minuteIn = (at: number, zone: Zone): number => {
    const parts = new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
    const part = (type: "hour" | "minute"): number => Number(parts.find((candidate) => candidate.type === type)?.value ?? 0);
    return (part("hour") % 24) * 60 + part("minute");
};

/**
 * Whether an instant falls inside the night window on a named clock, the switch aside: from `from` (inclusive) to `to`
 * (exclusive), across midnight when `to` is the earlier time. A window that begins where it ends is empty.
 */
export const withinNight = (hours: Pick<NightHours, "from" | "to">, zone: Zone, at: number): boolean => {
    const from = minutesOf(hours.from);
    const to = minutesOf(hours.to);
    const now = minuteIn(at, zone);
    if (from === to) {
        return false;
    }
    return from < to ? now >= from && now < to : now >= from || now < to;
};

/** The first instant after `at` that a named clock reads `to`: the morning that ends a night begun at `at`. */
export const morningAfter = (hours: Pick<NightHours, "to">, zone: Zone, at: number): number => {
    const minutes = minutesOf(hours.to);
    const on = (day: number): number => wallClockInstant(civilDayIn(day, zone), Math.floor(minutes / 60), minutes % 60, zone);
    const today = on(at);
    return today > at ? today : on(nextDayStartIn(at, zone));
};

// How far ahead of the clock reading it a press may be stamped and still count as begun: the browser that stamped it
// may run fast, and the board reads it off a clock that ticks once a minute. Further ahead is no night at all.
const STAMP_AHEAD_MS = 15 * 60_000;

/** The morning a night begun by hand ends at, while it has not come yet; undefined when there is none in force. */
export const nightByHandUntil = (hours: Pick<NightHours, "to" | "asleepSince">, zone: Zone, at: number): number | undefined => {
    if (hours.asleepSince === undefined || hours.asleepSince - at > STAMP_AHEAD_MS) {
        return undefined;
    }
    const morning = morningAfter(hours, zone, hours.asleepSince);
    return at < morning ? morning : undefined;
};

/**
 * Whether it is night at an instant on a named clock, nobody at the editor aside: begun by hand and its morning not
 * yet come, or night hours on and the instant inside their window.
 */
export const nightAt = (hours: NightHours, zone: Zone, at: number): boolean =>
    nightByHandUntil(hours, zone, at) !== undefined || (hours.on && withinNight(hours, zone, at));

/** How long a night window lasts, in minutes: what the settings row says beside the two times. */
export const nightLength = (hours: Pick<NightHours, "from" | "to">): number => (minutesOf(hours.to) - minutesOf(hours.from) + 24 * 60) % (24 * 60);

// What a card carries once night hours answered it rather than a person, on the reply and on the frozen card: which of
// the answers it got, and when that night ended, so the agent and the morning reader can both tell it apart from a pick
// somebody made. `picked`: a question answered with the agent's own recommendation; `saved`: a question kept for the
// morning; `approved`: a plan the agent chose to make, approved so the work could go on.
export const NightAnswerSchema = z.object({
    outcome: z.enum(["picked", "saved", "approved"]).describe("How night hours answered it: picked the agent's recommendation, saved the question for the morning, or approved the plan."),
    until: ClockTimeSchema.describe("When the night hours it fell in end, as HH:MM on the sandbox's clock."),
});
export type NightAnswer = z.infer<typeof NightAnswerSchema>;
