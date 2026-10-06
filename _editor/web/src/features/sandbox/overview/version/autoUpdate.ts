import type { AutoUpdate, AutoUpdateHold } from "@intentic/sandbox-contract";
import type { IconName } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { formatUntil } from "@intentic/ui/time";
import { formatDuration } from "@intentic/ui/format";

// WHAT AN UPDATE THAT TAKES ITSELF SAYS. The daemon decides the moment (system/updates/auto-update.ts) and says where it
// stands on /info: waiting and on what, counting down, handing itself to the machine. This turns that into the card's
// and the lane's words, and decides which of the owner's three answers apply (not today, not now, resume). Pure, so every
// sentence and every rule is checked without mounting anything (autoUpdate.test.ts).
//
// The tone throughout is a promise kept rather than a warning: what will happen, when, and what it will not interrupt.
// A list of who it is waiting for reads as consideration ("LEDGERLY is working"), never as blame.

/** One thing an update is waiting on, as a line under the card's status. */
export interface HoldLine {
    readonly kind: string;
    readonly icon: IconName;
    readonly text: string;
}

const lower = (value: string): string => value.toLowerCase();

/** Who is at the editor, with this reader said as "you": the daemon names people as their name, else their email. */
const peopleLine = (names: readonly string[], me: readonly string[]): string => {
    const mine = new Set(me.map(lower));
    const others = names.filter((name) => !mine.has(lower(name)));
    const youToo = others.length < names.length;
    if (youToo) {
        return others.length === 0 ? t(`sandbox.autoUpdate.holdPeopleYou`) : t(`sandbox.autoUpdate.holdPeopleYouAnd`, { count: others.length });
    }
    const [first] = others;
    if (first === undefined) {
        return t(`sandbox.autoUpdate.holdOther`);
    }
    return others.length === 1 ? t(`sandbox.autoUpdate.holdPeopleOne`, { name: first }) : t(`sandbox.autoUpdate.holdPeopleMany`, { name: first, count: others.length - 1 });
};

const agentsLine = (names: readonly string[]): string => {
    const [first, second] = names;
    if (first === undefined) {
        return t(`sandbox.autoUpdate.holdAgentsSome`);
    }
    if (second === undefined) {
        return t(`sandbox.autoUpdate.holdAgentsOne`, { name: first });
    }
    return names.length === 2 ? t(`sandbox.autoUpdate.holdAgentsTwo`, { first, second }) : t(`sandbox.autoUpdate.holdAgentsMany`, { name: first, count: names.length - 1 });
};

/** One hold in the card's words. A kind this build does not know still says something true. */
export const holdLine = (hold: AutoUpdateHold, me: readonly string[], now: number): HoldLine => {
    const when = hold.until === undefined ? undefined : formatUntil(hold.until, now);
    switch (hold.kind) {
        case `agents`:
            return { kind: hold.kind, icon: `robot`, text: agentsLine(hold.names ?? []) };
        case `people`:
            return { kind: hold.kind, icon: `user`, text: peopleLine(hold.names ?? [], me) };
        case `terminal`:
            return { kind: hold.kind, icon: `terminal`, text: t(`sandbox.autoUpdate.holdTerminal`) };
        case `schedule`:
            return { kind: hold.kind, icon: `automations`, text: when === undefined ? t(`sandbox.autoUpdate.holdScheduleSoon`) : t(`sandbox.autoUpdate.holdSchedule`, { when }) };
        case `paused`:
            return { kind: hold.kind, icon: `pause`, text: when === undefined ? t(`sandbox.autoUpdate.holdPausedOpen`) : t(`sandbox.autoUpdate.holdPaused`, { when }) };
        case `machine`:
            return { kind: hold.kind, icon: `desktop`, text: t(`sandbox.autoUpdate.holdMachine`) };
        case `retry`:
            return { kind: hold.kind, icon: `refresh`, text: when === undefined ? t(`sandbox.autoUpdate.holdRetrySoon`) : t(`sandbox.autoUpdate.holdRetry`, { when }) };
        case `consent`:
            return { kind: hold.kind, icon: `code`, text: t(`sandbox.autoUpdate.holdConsent`) };
        default:
            return { kind: hold.kind, icon: `clock`, text: t(`sandbox.autoUpdate.holdOther`) };
    }
};

/** "1:30", "0:07": what is left of a countdown, never below zero. */
// Rounded up: a countdown that reads "0:00" has run out, not got under a second left.
export const countdownClock = (startsAt: number, now: number): string => formatDuration(Math.max(0, Math.ceil((startsAt - now) / 1000)));

/**
 * "Not today", as a moment: the next 04:00 on the reader's own clock that is at least four hours off. Overnight is
 * when a quiet moment is likeliest, so "not today" still lets it happen tonight; pressed after midnight, it means the
 * night after, since the reader is plainly still at it.
 */
export const notTodayUntil = (now: number): number => {
    const at = new Date(now);
    at.setHours(4, 0, 0, 0);
    while (at.getTime() - now < 4 * 60 * 60_000) {
        at.setDate(at.getDate() + 1);
    }
    return at.getTime();
};

/** "Not now", from the countdown: an hour, long enough to finish a thought, short enough not to forget it. */
export const NOT_NOW_MS = 60 * 60_000;

/** The owner's answers that apply right now, as the card draws them. */
export type AutoUpdateAnswer = `not-today` | `not-now` | `resume`;

export interface AutoUpdateStatus {
    readonly tone: `info` | `progress` | `paused` | `consent`;
    readonly icon: IconName;
    readonly spin: boolean;
    readonly title: string;
    readonly detail: string | undefined;
    /** What it waits on, one line each, the longest-lasting first; never the pause or the consent the title already says. */
    readonly lines: readonly HoldLine[];
    /** The last try's words, while that is still the news. */
    readonly failure: string | undefined;
    readonly answer: AutoUpdateAnswer | undefined;
}

export interface StatusFacts {
    readonly auto: AutoUpdate | undefined;
    /** An update is on offer but still downloading: the card says it will install itself once it is in. */
    readonly downloading: boolean;
    /** This reader's own name and email, so a hold on the person at the editor reads "you". */
    readonly me: readonly string[];
    readonly now: number;
}

/**
 * Where an update that takes itself stands, as the update card says it beside its button; undefined when there is
 * nothing to say (turned off, which the switch already says, or nothing on offer and nothing paused).
 */
export const autoUpdateStatus = ({ auto, downloading, me, now }: StatusFacts): AutoUpdateStatus | undefined => {
    if (auto === undefined || !auto.enabled) {
        return undefined;
    }
    const paused = auto.pausedUntil !== undefined && auto.pausedUntil > now ? auto.pausedUntil : undefined;
    const base = { spin: false, detail: undefined, lines: [], failure: auto.failure, answer: undefined } as const;
    if (auto.phase === `updating`) {
        return {
            ...base,
            tone: `progress`,
            icon: `refresh`,
            spin: true,
            title: auto.version === undefined ? t(`sandbox.autoUpdate.updatingTitleUnnamed`) : t(`sandbox.autoUpdate.updatingTitle`, { version: auto.version }),
            detail: t(`sandbox.autoUpdate.updatingDetail`),
            failure: undefined,
        };
    }
    if (auto.phase === `countdown` && auto.startsAt !== undefined) {
        return {
            ...base,
            tone: `progress`,
            icon: `clock`,
            title: t(`sandbox.autoUpdate.countdownTitle`, { time: countdownClock(auto.startsAt, now) }),
            detail: t(`sandbox.autoUpdate.countdownDetail`),
            answer: `not-now`,
        };
    }
    if (paused !== undefined) {
        return { ...base, tone: `paused`, icon: `pause`, title: t(`sandbox.autoUpdate.pausedTitle`, { when: formatUntil(paused, now) }), answer: `resume` };
    }
    if (auto.phase === `waiting`) {
        // A release that changes what developers build on is the owner's to take, whatever else is going on.
        if (auto.holds.some((hold) => hold.kind === `consent`)) {
            return { ...base, tone: `consent`, icon: `code`, title: t(`sandbox.autoUpdate.consentTitle`), detail: t(`sandbox.autoUpdate.consentDetail`) };
        }
        return {
            ...base,
            tone: `info`,
            icon: `clock`,
            title: t(`sandbox.autoUpdate.quietMoment`),
            detail: t(`sandbox.autoUpdate.quietMomentDetail`),
            lines: auto.holds.filter((hold) => hold.kind !== `paused`).map((hold) => holdLine(hold, me, now)),
            answer: `not-today`,
        };
    }
    // Nothing staged yet: once the download is in, the same promise applies.
    return downloading ? { ...base, tone: `info`, icon: `clock`, title: t(`sandbox.autoUpdate.afterDownload`), failure: undefined } : undefined;
};

/**
 * The lane's card, for whoever is still connected while the sandbox is about to restart, or already handing itself to
 * the machine: shown only while the sandbox still answers, since the outage that follows has its own card (the restart
 * ledger, armed by the watch). Undefined for everything else, which waits quietly on the update card.
 */
export interface AutoUpdateNotice {
    readonly title: string;
    readonly detail: string;
    readonly spin: boolean;
    readonly counting: boolean;
}

export const autoUpdateNotice = (auto: AutoUpdate | undefined, now: number): AutoUpdateNotice | undefined => {
    if (auto?.enabled !== true) {
        return undefined;
    }
    if (auto.phase === `countdown` && auto.startsAt !== undefined) {
        return {
            title: t(`sandbox.autoUpdate.countdownTitle`, { time: countdownClock(auto.startsAt, now) }),
            detail: auto.version === undefined ? t(`sandbox.autoUpdate.countdownNoticeUnnamed`) : t(`sandbox.autoUpdate.countdownNotice`, { version: auto.version }),
            spin: false,
            counting: true,
        };
    }
    if (auto.phase === `updating`) {
        return {
            title: auto.version === undefined ? t(`sandbox.autoUpdate.updatingTitleUnnamed`) : t(`sandbox.autoUpdate.updatingTitle`, { version: auto.version }),
            detail: t(`sandbox.autoUpdate.updatingDetail`),
            spin: true,
            counting: false,
        };
    }
    return undefined;
};
