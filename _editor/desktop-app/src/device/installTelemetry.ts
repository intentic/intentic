import { EXIT_NEEDS_CONSENT, EXIT_NEEDS_RESTART, parseStep, readMarker, type RequirementProgress, type RunEvent } from "../desktop";
import { parseLayer, type Progress } from "../setupPlan";

// WHERE A SETUP'S TIME GOES, as the funnel hears it (setup.ts sends it): how long each step of the plan ran, how long
// each requirement row ran and how much of that it sat waiting on the person (Windows' permission prompt), and, for a
// run that failed, why, in a few scrubbed words. All of it pure, given the clock.

/** How a step, or the run it ended on, ended: the designed stops (desktop.ts) are their own words, not failures. */
export type StepOutcome = `done` | `failed` | `stopped` | `parked` | `consent`;

/** A requirement row's ending. A run that stopped to ask for consent stopped its rows too. */
export type RequirementOutcome = `done` | `failed` | `parked` | `stopped`;

/** Milliseconds from `from` to `to`, as seconds to a tenth: what every timing here is reported in. */
export const secondsBetween = (from: number, to: number): number => Math.round(Math.max(0, to - from) / 100) / 10;

/** How a run ended, for the step it ended on: the reader's stop first, then the two designed stops, then the exit. */
export const runEnding = (ended: { readonly ok: boolean; readonly code: number | null | undefined; readonly stopped: boolean }): StepOutcome => {
    if (ended.stopped) {
        return `stopped`;
    }
    if (ended.code === EXIT_NEEDS_RESTART) {
        return `parked`;
    }
    if (ended.code === EXIT_NEEDS_CONSENT) {
        return `consent`;
    }
    return ended.ok ? `done` : `failed`;
};

/** A step of the plan the cursor was on, and for how long. */
export interface StepTime {
    readonly step: string;
    readonly seconds: number;
}

/** The step the cursor is on at `at` and how long it has been there; none before the first step is entered. */
export const openStep = (state: Progress, at: number): StepTime | undefined => {
    const step = state.index < 0 ? undefined : state.plan[state.index];
    return step === undefined ? undefined : { step: step.phase, seconds: secondsBetween(state.stepStartedAt, at) };
};

/** The step an event moved the cursor off, timed to that moment; none when the cursor stayed where it was. */
export const stepLeft = (before: Progress, after: Progress, at: number): StepTime | undefined =>
    after.index === before.index ? undefined : openStep(before, at);

/** One requirement row's clock, from its first `running` marker. */
export interface RequirementClock {
    readonly startedAt: number;
    /** Since when its markers have said the person is needed (`needs: "you"`), while they still say so. */
    readonly youSince?: number;
    /** Milliseconds already spent waiting on the person, before `youSince`. */
    readonly waitedMs: number;
}

export type RequirementClocks = Readonly<Record<string, RequirementClock>>;

/** A requirement row that finished, or that the run ended under. */
export interface RequirementTime {
    readonly id: string;
    readonly outcome: RequirementOutcome;
    readonly seconds: number;
    readonly waitedForYouSeconds: number;
}

const waitedMs = (clock: RequirementClock, at: number): number => clock.waitedMs + (clock.youSince === undefined ? 0 : Math.max(0, at - clock.youSince));

const timeOf = (id: string, clock: RequirementClock, outcome: RequirementOutcome, at: number): RequirementTime => ({
    id,
    outcome,
    seconds: secondsBetween(clock.startedAt, at),
    waitedForYouSeconds: secondsBetween(0, waitedMs(clock, at)),
});

/**
 * One live marker folded into the clocks: a `running` row starts its clock (and its wait on the person whenever the
 * marker says so, stopping it when one no longer does), a row that finishes hands back its time. A row that finishes
 * without ever having run has no time to report.
 */
export const foldRequirement = (
    clocks: RequirementClocks,
    state: RequirementProgress,
    now: number,
): { readonly clocks: RequirementClocks; readonly finished?: RequirementTime } => {
    const clock = clocks[state.id];
    if (state.state === `running`) {
        const running = clock ?? { startedAt: now, waitedMs: 0 };
        const youSince = state.needsYou === true ? (running.youSince ?? now) : undefined;
        const next: RequirementClock = {
            startedAt: running.startedAt,
            waitedMs: youSince === undefined ? waitedMs(running, now) : running.waitedMs,
            ...(youSince === undefined ? {} : { youSince }),
        };
        return { clocks: { ...clocks, [state.id]: next } };
    }
    if (clock === undefined) {
        return { clocks };
    }
    const rest = Object.fromEntries(Object.entries(clocks).filter(([id]) => id !== state.id));
    return { clocks: rest, finished: timeOf(state.id, clock, state.state, now) };
};

const requirementEnding = (ending: StepOutcome): RequirementOutcome => (ending === `consent` ? `stopped` : ending);

/** Every row still running when the run ended, ended the way the run did. */
export const endRequirements = (clocks: RequirementClocks, ending: StepOutcome, at: number): RequirementTime[] =>
    Object.entries(clocks).map(([id, clock]) => timeOf(id, clock, requirementEnding(ending), at));

/* WHY A RUN FAILED, in its own last words. */

// How the run's own tools say they failed: `ic`'s error line (its ui.rs, plain when piped), a fatal one, and the app's
// "Command failed," for a child that answered nothing.
const ERROR_LINE = /^(?:error|fatal)\b|^Command failed\b/i;

// A line that says something: not blank, and not the progress the bar is drawn from or a marker for the card.
const says = (text: string): boolean => text !== `` && parseStep(text) === undefined && parseLayer(text) === undefined && readMarker(text) === undefined;

/** The line a failed run ended on: its last error line, else the last thing it said on stderr; none when it said none. */
export const failureLine = (events: readonly RunEvent[]): string | undefined => {
    const lines = events.flatMap((event) => (event.kind === `line` ? [{ stream: event.stream, text: event.text.trim() }] : []));
    return (
        lines.findLast((line) => ERROR_LINE.test(line.text))?.text ?? lines.findLast((line) => line.stream === `stderr` && says(line.text))?.text
    );
};

/** This account's home folder, read off a path inside it (the run's transcript, `~/.intentic/logs/…`). */
export const homeOf = (path: string | undefined): string | undefined => {
    const at = path?.search(/[\\/]\.intentic[\\/]/) ?? -1;
    return path === undefined || at <= 0 ? undefined : path.slice(0, at);
};

const REASON_CHARS = 300;
const EMAIL = /[\w.%+-]+@[\w-]+(?:\.[\w-]+)+/g;
// Somebody's home folder where the run's own was not known: a Windows profile, or a Unix home, up to the next separator.
const ANY_HOME = /\b[A-Za-z]:[\\/]Users[\\/][^\\/\s"']+|(?<![\w.~])\/(?:home|Users)\/[^/\s"']+/gi;
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, `\\$&`);

/**
 * A reason as an event may carry it: the home folder said as `~` (either slash, any case, as Windows reads it), the
 * account it is named for as `<user>` (a requirement's sentences name the Windows account), no email address and no
 * setup code, on one line and at most 300 characters.
 */
export const scrubReason = (text: string, hide: { readonly home?: string; readonly code?: string }): string => {
    let said = text.replace(/\s+/g, ` `).trim();
    const home = hide.home ?? ``;
    if (home.length > 3) {
        said = said.replace(new RegExp(home.split(/[\\/]/).map(escaped).join(`[\\\\/]`), `gi`), `~`);
        const account = home.split(/[\\/]/).at(-1) ?? ``;
        if (account.length >= 3) {
            said = said.replace(new RegExp(`(?<![\\w.-])${escaped(account)}(?![\\w-])`, `gi`), `<user>`);
        }
    }
    said = said.replace(ANY_HOME, `~`).replace(EMAIL, `<email>`);
    if ((hide.code ?? ``).length >= 4) {
        said = said.replaceAll(hide.code ?? ``, `<code>`);
    }
    return said.length > REASON_CHARS ? `${said.slice(0, REASON_CHARS - 1)}…` : said;
};
