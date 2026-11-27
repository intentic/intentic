import { type HostPowerFinding, pauseUntilFor, POWER_FINDING, POWER_REMEDY } from "@intentic/sandbox-contract/schemas/host-power";
import type { HostPowerNeed } from "@intentic/sandbox-contract/schemas/needs";
import type { TipRow } from "@intentic/ui";
import { formatElapsed, formatWhen } from "@intentic/ui/format";
import { t } from "@intentic/ui/i18n";

// A COMPUTER'S POWER SETTINGS IN THE READER'S WORDS (host-power.ts). The machine agent reports each setting that would stop
// work left running on it as a finding: structured fields, and an English sentence of its own. The words here are built
// from the fields, so a finding reads the same on the chat card that asks to change it and on the Devices page that offers
// the same change, and reads in Polish too. A finding this build has no words for says the agent's sentence: a newer
// agent's id is one more line, never a blank.

/** One finding as a line: what it does now and, for one `power-stay-on` changes, what it does after. */
export interface PowerLine {
    readonly key: string;
    readonly now: string;
    readonly becomes?: string | undefined;
}

/** A finding nothing here changes, said as a note: what to know, and the command to run by hand where there is one. */
export interface PowerNote {
    readonly key: string;
    readonly text: string;
    readonly command?: string | undefined;
}

// The agent's sentence as a clause, so it can stand where ours would ("…, so work booked for the night waits").
const clause = (text: string): string => text.trim().replace(/\.$/u, ``);

const hour = (value: number): string => `${String(value).padStart(2, `0`)}:00`;

// Ours only where the fields say what ours claim: a timeout we can put a number on, on mains power, which is the one the
// op changes. Anything else is the agent's own sentence.
const mainsAfter = (finding: HostPowerFinding): string | undefined =>
    finding.power === `dc` || finding.afterSeconds === undefined ? undefined : formatElapsed(finding.afterSeconds);

const lidNow = (action: string | undefined): string | undefined =>
    action === `sleep`
        ? t(`sandbox.hostPower.lidSleep`)
        : action === `hibernate`
          ? t(`sandbox.hostPower.lidHibernate`)
          : action === `shut-down`
            ? t(`sandbox.hostPower.lidShutDown`)
            : undefined;

// What each finding the op changes does now, and what it does after. `undefined` for one this build has no words for.
const knownLine = (finding: HostPowerFinding): Omit<PowerLine, `key`> | undefined => {
    const after = mainsAfter(finding);
    switch (finding.id) {
        case POWER_FINDING.sleepIdle:
            return after === undefined ? undefined : { now: t(`sandbox.hostPower.sleepIdle`, { after }), becomes: t(`sandbox.hostPower.never`) };
        case POWER_FINDING.hibernateIdle:
            return after === undefined ? undefined : { now: t(`sandbox.hostPower.hibernateIdle`, { after }), becomes: t(`sandbox.hostPower.never`) };
        case POWER_FINDING.lidClose: {
            const now = finding.power === `dc` ? undefined : lidNow(finding.action);
            return now === undefined ? undefined : { now, becomes: t(`sandbox.hostPower.nothing`) };
        }
        case POWER_FINDING.standbyNetwork:
            return { now: t(`sandbox.hostPower.standbyNetwork`), becomes: t(`sandbox.hostPower.keepsNetwork`) };
        default:
            return undefined;
    }
};

/** A finding as a line, its after-state only where the op changes it and we have words for both. */
export const powerLine = (finding: HostPowerFinding, index = 0): PowerLine => {
    const known = knownLine(finding);
    const key = `${finding.id}:${index}`;
    if (known === undefined) {
        return { key, now: clause(finding.text) };
    }
    return finding.fixable ? { key, ...known } : { key, now: known.now };
};

/**
 * A finding nothing here changes, as a note to the reader. `device` names the computer, whose clock an update window is
 * read on: the card carries the window in that computer's own hours and no offset to move them by.
 */
export const powerNote = (finding: HostPowerFinding, device: string, index = 0): PowerNote => {
    const key = `${finding.id}:${index}`;
    switch (finding.id) {
        case POWER_FINDING.batterySleep:
            return {
                key,
                text:
                    finding.afterSeconds === undefined
                        ? t(`sandbox.hostPower.batterySleepAny`)
                        : t(`sandbox.hostPower.batterySleep`, { after: formatElapsed(finding.afterSeconds) }),
            };
        case POWER_FINDING.updateRestart:
            return { key, text: restartWords(finding, device) };
        case POWER_FINDING.osSleep:
            return finding.command === undefined
                ? { key, text: finding.text }
                : { key, text: t(`sandbox.hostPower.osSleep`, { device }), command: finding.command };
        default:
            return { key, text: finding.text, command: finding.command };
    }
};

// A Windows Update restart in the reader's words: its hours on the computer's clock, then what follows it, which since
// 2026-11-27 the finding says (`comesBack`, `pausedUntil`). A finding that names no hours, or the whole day, is the
// agent's own sentence. Pure.
const restartWords = (finding: HostPowerFinding, device: string): string => {
    const window = finding.window;
    // Equal hours are the whole day (insideLocalWindow), which "between 03:00 and 03:00" would not say.
    if (window === undefined || window.fromHour === window.toHour) {
        return finding.text;
    }
    const hours = { from: hour(window.fromHour), to: hour(window.toHour), device };
    if (finding.comesBack === `boot`) {
        return t(`sandbox.hostPower.updateRestartBoot`, hours);
    }
    return finding.pausedUntil === undefined
        ? t(`sandbox.hostPower.updateRestart`, hours)
        : t(`sandbox.hostPower.updateRestartPaused`, { ...hours, until: formatWhen(finding.pausedUntil) });
};

/** One answer the host-power card offers to a Windows Update restart: which, and the moment a pause holds until. */
export interface RestartRemedy {
    readonly remedy: (typeof POWER_REMEDY)[keyof typeof POWER_REMEDY];
    readonly until?: number | undefined;
}

/**
 * The answers a host-power card offers to its restart, the lasting one first: none where the finding offers none (an
 * older agent), where the computer already brings its sandboxes back, or where Windows Update is paused past the work.
 * A pause is offered only where its end can be placed on the computer's clock and Windows would hold it that long. Pure.
 */
export const restartRemedies = (subject: Pick<HostPowerNeed, `findings` | `dueAt` | `utcOffsetMinutes`>, now: number): RestartRemedy[] => {
    const restart = subject.findings.find((finding) => finding.id === POWER_FINDING.updateRestart);
    const offers = restart?.offers ?? [];
    const due = subject.dueAt ?? now;
    if (restart === undefined || restart.comesBack === `boot` || (restart.pausedUntil ?? 0) >= due) {
        return [];
    }
    const until = subject.utcOffsetMinutes === undefined ? undefined : pauseUntilFor(restart, subject.utcOffsetMinutes, now, due);
    return [
        ...(offers.includes(POWER_REMEDY.beforeSignIn) ? [{ remedy: POWER_REMEDY.beforeSignIn }] : []),
        ...(offers.includes(POWER_REMEDY.pauseUpdates) && until !== undefined ? [{ remedy: POWER_REMEDY.pauseUpdates, until }] : []),
    ];
};

/** A note that an update already waits for a restart, which a pause may not hold off; undefined where none waits. */
export const restartPendingNote = (subject: Pick<HostPowerNeed, `findings`>, device: string): string | undefined =>
    subject.findings.some((finding) => finding.id === POWER_FINDING.updateRestart && finding.restartPending === true)
        ? t(`sandbox.hostPower.restartPending`, { device })
        : undefined;

// What stops booked work soonest goes first: the shorter of the two idle timeouts, then the lid, which only counts once
// it is closed, then the network in standby, which only counts once it is asleep.
const RANK = new Map<string, number>([
    [POWER_FINDING.sleepIdle, 0],
    [POWER_FINDING.hibernateIdle, 0],
    [POWER_FINDING.lidClose, 1],
    [POWER_FINDING.standbyNetwork, 2],
]);
const rankOf = (finding: HostPowerFinding): number => RANK.get(finding.id) ?? 3;

/** The findings worst first. Pure. */
export const worstFirst = (findings: readonly HostPowerFinding[]): HostPowerFinding[] =>
    [...findings].sort(
        (a, b) => rankOf(a) - rankOf(b) || (a.afterSeconds ?? Number.POSITIVE_INFINITY) - (b.afterSeconds ?? Number.POSITIVE_INFINITY),
    );

const lidValue = (action: string | undefined): string | undefined =>
    action === `sleep`
        ? t(`sandbox.hostPower.lidSleeps`)
        : action === `hibernate`
          ? t(`sandbox.hostPower.lidHibernates`)
          : action === `shut-down`
            ? t(`sandbox.hostPower.lidShutsDown`)
            : undefined;

// A finding as a tip card's row: a word or two and the figure it comes to.
const knownRow = (finding: HostPowerFinding): TipRow | undefined => {
    const after = mainsAfter(finding);
    switch (finding.id) {
        case POWER_FINDING.sleepIdle:
            return after === undefined ? undefined : { label: t(`sandbox.hostPower.rowSleep`), value: after };
        case POWER_FINDING.hibernateIdle:
            return after === undefined ? undefined : { label: t(`sandbox.hostPower.rowHibernate`), value: after };
        case POWER_FINDING.lidClose: {
            const value = lidValue(finding.action);
            return value === undefined ? undefined : { label: t(`sandbox.hostPower.rowLid`), value };
        }
        case POWER_FINDING.standbyNetwork:
            return { label: t(`sandbox.hostPower.rowStandby`), value: t(`sandbox.hostPower.noNetwork`) };
        default:
            return undefined;
    }
};

/** A finding as one row of a tip card; one we have no words for is its id and the agent's sentence. */
export const powerRow = (finding: HostPowerFinding): TipRow => knownRow(finding) ?? { label: finding.id, value: clause(finding.text) };
