import { Cron } from "croner";
import type { Automation, Trigger } from "@intentic/sandbox-contract/schemas/automations";
import type { Zone } from "@intentic/sandbox-contract/time/zone";
import { cronOptions, wallClockIn } from "@intentic/sandbox-contract/time/zone";
import type { Services } from "../composition.js";
import { reposOf } from "../conversations/registry/agents-store.js";
import type { AutomationRecord } from "./automations-store.js";
import type { ScheduleMark } from "./schedule-coverage.js";
import { nextDueAfter, nextRunOf, sandboxZone, zoneOf } from "./schedule-zone.js";
import { type DueAt, nudgedPass } from "../workload/nudged-pass.js";
import { expireAutomation } from "./watch/fire-targets.js";
import { forgetHeldWake } from "./durable/fire-admission.js";
import { withdrawApprovalPush } from "./held-wake-answers.js";
import { fireAutomation, runHeldWake, recordHeldWake } from "./fire/automation-fire.js";

export interface AutomationsScheduler {
    readonly start: () => void;
    readonly stop: () => void;
    // One poll pass over the manifest; `start` runs it on an interval. A call while a pass still runs joins that pass.
    // Exposed for tests.
    readonly tick: (now?: number) => Promise<void>;
    // A pass soon, or once more after the one running: what a turn settling or an automation saved asks for, since
    // either may have made something due now (a countdown hold waiting for quiet, a schedule saved inside this window).
    readonly nudge: () => void;
}

// The soonest one-time wake, 0 when none is armed: one of the promised wakes every sleep keeps
// (bootstrap/promised-wakes.ts). Held apart from `nextCronWakeAt` because it reads the instant off the trigger.
export const nextOneTimeWakeAt = async (services: Services): Promise<number> => {
    // Reads the moment off the trigger rather than through `nextRunOf`: a one-time wake IS an instant, so it needs no
    // zone, and routing it through the cron path would make this depend on a setting it has no business reading.
    const due = (await services.automations.list()).flatMap((automation) =>
        automation.enabled && automation.trigger.kind === "once" ? [automation.trigger.at] : [],
    );
    return due.length === 0 ? 0 : Math.min(...due);
};

// The soonest moment a cron fires, for the sleep alarm and anyone restarting through it (bootstrap/promised-wakes.ts);
// 0 when none is armed. One-time wakes carry their instant directly; a cron needs its next run on the sandbox's clock.
export const nextCronWakeAt = async (services: Services): Promise<number> => {
    const zone = await sandboxZone(services);
    const due = (await services.automations.list()).flatMap((automation) =>
        automation.trigger.kind === "schedule" ? [nextRunOf(automation, zone) ?? 0].filter((at) => at > 0) : [],
    );
    return due.length === 0 ? 0 : Math.min(...due);
};

// The soonest a held wake's countdown ends, for whoever must not sleep through it (bootstrap/promised-wakes.ts); 0 when none
// counts down. The sandbox told its owner a `holdForSeconds` hold would go ahead by itself, and only its own clock lets it:
// a hold that waits on a person (`requireApproval`) has no moment and is not counted.
export const nextCountdownWakeAt = async (services: Services): Promise<number> => {
    const due = (await services.heldWakes.list()).flatMap((held) => (held.autoRunAt === undefined ? [] : [held.autoRunAt]));
    return due.length === 0 ? 0 : Math.min(...due);
};

// Past this, a one-time wake did not merely wait out a poll: nothing was running when its moment came, and the woken
// turn is told so, because "your 3pm reminder" delivered at 9pm has to say which of the two times it means.
const LATE_WAKE_MS = 2 * 60_000;

// The instant in ISO because that is what a model reads without ambiguity, AND the same instant on the owner's own
// clock, because that is the one they will recognise. A note carrying only "18:43Z" makes the agent do the conversion
// itself to say anything useful, and it has no reliable way to know which zone to convert into.
const lateWakeNote = (at: number, now: number, zone: Zone): string =>
    [
        `This wake was due at ${new Date(at).toISOString()} (${wallClockIn(at, zone)}), and is running`,
        `${Math.round((now - at) / 60_000)} minutes late: the sandbox was not running when its moment came, and fired it`,
        `at the first opportunity after.`,
        `If you pass this on to somebody, say when it was meant to arrive rather than implying it is on time,`,
        `and say it on the ${zone} clock rather than in UTC.`,
    ].join(" ");

// Whether an interrupted fire of this automation may be re-fired at boot (turn-resume.ts). A retired `once` was
// switched off BY its own fire rather than by the owner, so one the daemon died under still resumes; every other
// trigger reads `enabled` as the owner's own answer, and a switched-off automation stays off.
// A watch waiting for one thing (`until: first-fire`) retires the same way, by its own fire.
export const resumable = (automation: Pick<Automation, "enabled" | "trigger" | "until">): boolean =>
    automation.enabled || automation.trigger.kind === "once" || automation.until === "first-fire";

// Fires a one-time wake whose moment has arrived, switching it off FIRST: `at` stays in the past forever, so every
// later poll would match it again and the switch is the only thing standing between one reminder and one every 30
// seconds. Retired before the fire rather than after, so a daemon that dies mid-wake still cannot repeat it — the
// interrupted fire comes back through the turn journal instead (see `resumable`).
// Deliberately not gated on the poll window the cron path uses: a moment that passed while the sandbox was down still
// fires, late and saying so. A cron's missed moments are the boot's catch-up instead (`catchUp`), since a cron has
// many and is owed only one of them.
const fireOnceWake = async (services: Services, automation: AutomationRecord, at: number, now: number, sandbox: Zone): Promise<void> => {
    if (at > now) {
        return;
    }
    // The sandbox's zone, never a per-automation override: a one-time wake stores an instant and has no zone of its
    // own, and the clock the owner will recognise is the sandbox's.
    const late = now - at >= LATE_WAKE_MS ? { payload: lateWakeNote(at, now, sandbox) } : {};
    // Switched off once the fire is journalled, so a crash in between replays that fire rather than losing the wake.
    const retire = async (): Promise<void> => {
        await services.automations.setEnabled(automation.id, false);
    };
    void fireAutomation(services, automation, { ...late, accepted: retire }).catch((error: unknown) =>
        services.logger.error({ err: error, automation: automation.id }, "one-time automation run failed"),
    );
};

// One enabled automation's clock, per poll: a one-time wake fires the moment it is due or already overdue, a cron
// fires when its next run measured from the last poll falls inside this one. Every other trigger has its own
// dispatcher and nothing to do here. Answers the moment a cron fired for, which is how far its clock is now covered.
const fireIfDue = async (services: Services, automation: AutomationRecord, windowStart: number, now: number, sandbox: Zone): Promise<number | undefined> => {
    if (automation.trigger.kind === "once") {
        await fireOnceWake(services, automation, automation.trigger.at, now, sandbox);
        return undefined;
    }
    if (automation.trigger.kind !== "schedule") {
        return undefined;
    }
    // A cron hand-edited into invalidity only silences its own automation, never the tick.
    let due: Date | null;
    try {
        due = new Cron(automation.trigger.cron, cronOptions(zoneOf(automation.trigger, sandbox))).nextRun(new Date(windowStart));
    } catch {
        // allow(silent-catch): an invalid cron silences only its own automation, never the tick.
        return undefined;
    }
    if (due === null || due.getTime() > now) {
        return undefined;
    }
    void fireAutomation(services, automation).catch((error: unknown) =>
        services.logger.error({ err: error, automation: automation.id }, "automation run failed"),
    );
    return due.getTime();
};

// A detached fire's failure, logged rather than lost: nothing awaits it.
const loggedAs =
    (services: Pick<Services, "logger">, message: string, automation?: string) =>
    (error: unknown): void =>
        services.logger.error({ err: error, automation }, message);

// What a pass changes about the schedules' coverage marks (schedule-coverage.ts); undefined drops a mark.
type MarkChanges = Record<string, ScheduleMark | undefined>;

// The marks that follow from the manifest alone, as of `at`: a schedule seen on with no live mark is armed from then (a
// new one, or one switched back on, owes nothing from before); one seen off is marked off; a mark whose automation is
// gone or no longer a schedule is dropped. Empty when nothing moved, which is every ordinary poll.
export const armingMarks = (automations: readonly AutomationRecord[], marks: Readonly<Record<string, ScheduleMark>>, at: number) => {
    const changes: MarkChanges = {};
    const schedules = new Set<string>();
    for (const automation of automations) {
        if (automation.trigger.kind !== "schedule") {
            continue;
        }
        schedules.add(automation.id);
        const mark = marks[automation.id];
        if (automation.enabled && (mark === undefined || mark.off === true)) {
            changes[automation.id] = { coveredUntil: at };
        }
        if (!automation.enabled && mark?.off !== true) {
            changes[automation.id] = { coveredUntil: at, off: true };
        }
    }
    for (const id of Object.keys(marks)) {
        if (!schedules.has(id)) {
            changes[id] = undefined;
        }
    }
    return changes;
};

// The latest moment of an enabled schedule that passed after its clock was last accounted for and by `horizon`, or
// undefined when none is owed. Accounted for is the later of its coverage mark and its newest run; with neither (an
// automation this build has never seen armed and that never ran) nothing is owed, so nothing fires unasked. One seen
// switched off owes nothing either: switching it back on is not asking for what it skipped.
export const missedMoment = (automation: AutomationRecord, mark: ScheduleMark | undefined, horizon: number, sandbox: Zone): number | undefined => {
    if (automation.trigger.kind !== "schedule" || mark?.off === true) {
        return undefined;
    }
    const accounted = [mark?.coveredUntil, automation.runs[0]?.at].filter((at): at is number => at !== undefined);
    if (accounted.length === 0) {
        return undefined;
    }
    try {
        const cron = new Cron(automation.trigger.cron, cronOptions(zoneOf(automation.trigger, sandbox)));
        const first = cron.nextRun(new Date(Math.max(...accounted)))?.getTime();
        if (first === undefined || first > horizon) {
            return undefined;
        }
        // Strictly before its reference, so one past the horizon finds a moment AT the horizon too.
        return Math.max(first, cron.previousRuns(1, new Date(horizon + 1))[0]?.getTime() ?? first);
    } catch {
        // allow(silent-catch): an invalid cron owes nothing, as it never fires on a poll either.
        return undefined;
    }
};

// A repair of the main tree waits for lands to stop moving it, and no longer than this once its countdown is over.
export const LAND_QUIET_MS = 5 * 60_000;

export const LAND_QUIET_CAP_MS = 60 * 60_000;

// The newest land any conversation made, epoch ms; 0 when none has.
const lastLandAt = (services: Services): number =>
    Math.max(
        0,
        ...services.agents.list().flatMap((summary) => {
            const entry = services.agents.entry(summary.id);
            return (entry === undefined ? [] : reposOf(entry)).map((repo) => repo.landedAt ?? 0);
        }),
    );

// Whether a held wake past its countdown may start: one woken by the workspace repairs the main tree, which only lands
// move, so it waits out lands; any other waits out every live turn, since it would start work under someone.
export const heldWakeQuiet = (
    trigger: Trigger["kind"] | undefined,
    now: number,
    fleet: { readonly lastLand: number; readonly liveTurns: number; readonly autoRunAt: number },
): boolean => (trigger === "workspace" ? now - fleet.lastLand >= LAND_QUIET_MS || now - fleet.autoRunAt >= LAND_QUIET_CAP_MS : fleet.liveTurns === 0);

// What heldWakeQuiet reads, asking only what the trigger's rule needs: land times for a repair, live turns otherwise.
const fleetFor = (services: Services, trigger: Trigger["kind"] | undefined, autoRunAt: number) =>
    trigger === "workspace"
        ? { lastLand: lastLandAt(services), liveTurns: 0, autoRunAt }
        : { lastLand: 0, liveTurns: services.conversations.liveSessionIds().length, autoRunAt };

// Releases countdown holds past deadline once quiet (heldWakeQuiet); removed before running so it can't re-fire. A
// retired one-time wake still releases: it was switched off by the very fire now waiting in the queue.
// A countdown still running reports its end to `due`, so the pass is woken on it rather than up to a poll late; one past
// it that waits for quiet is woken by the turn settling or the land that brings it (createAutomationsScheduler.nudge).
const releaseCountdownHolds = async (services: Services, now: number, due: DueAt): Promise<void> => {
    // `list` shows a countdown only on a hold the daemon minted, and the release checks it again as it takes the hold out.
    for (const held of await services.heldWakes.list()) {
        if (held.autoRunAt === undefined) {
            continue;
        }
        if (held.autoRunAt > now) {
            due(held.autoRunAt);
            continue;
        }
        const automation = await services.automations.get(held.automationId);
        if (!heldWakeQuiet(automation?.trigger.kind, now, fleetFor(services, automation?.trigger.kind, held.autoRunAt))) {
            continue;
        }
        // Only the release that takes the entry runs it: an approval racing this pass has already fired it.
        const released = await services.heldWakes.releaseCountdown(held.id, now, (wake) => recordHeldWake(services, wake));
        if (released === undefined) {
            continue;
        }
        if (automation === undefined || !resumable(automation)) {
            await forgetHeldWake(services, released.id);
            continue;
        }
        void withdrawApprovalPush(services, held.automationId);
        void runHeldWake(services, automation, released).catch(loggedAs(services, "countdown-released automation run failed", automation.id));
    }
};

// Polls the manifest and fires whatever came due since the last pass; fires run detached, since a turn can outlast many
// polls. Event automations fire from the fire route instead.
// Every pass of a started scheduler also sets one timer for the soonest moment due within a poll (schedule-zone.ts) or
// countdown ending, so a schedule fires on its minute rather than up to a poll late. A turn settling, a land and an
// automation saved nudge a pass at once (boot-schedulers.ts, 2026-10-20): a held wake waiting for no live turn went on
// the next thirty-second pass after the last turn ended, and a schedule saved due inside the current window was armed
// only at the next pass. The interval stays as the backstop for anything those miss.
// What happened while nothing was running is the start's to settle (`catchUp`): a host or platform outage can miss even
// a promised alarm. Each schedule that missed a moment fires ONCE, however many it missed, late and saying so, through
// the same gates as any fire: the sessions bar, the guard, an approval hold. A
// schedule asks for its work to be done regularly, not for a backlog to be replayed.
export const createAutomationsScheduler = (services: Services, intervalMs = 30_000): AutomationsScheduler => {
    // Where the first poll's window opens, and so where the catch-up's ends: a moment is one pass's or the other's.
    let since = Date.now();
    let started = false;
    // One pass at a time (nudgedPass): an interval, a timer or a nudge that comes round while the last pass still runs
    // joins it. A second pass would read the manifest before the first had switched a fired one-time wake off, and fire
    // it again; joining loses nothing, since the next pass's window opens where the last one's closed.
    const pass = async (now: number, due: DueAt): Promise<void> => {
        const windowStart = since;
        since = now;
        // Read once per poll, not per automation: the owner's zone cannot change between two rows of the same pass,
        // and a settings read per automation would make a manifest of fifty chores fifty file reads a tick.
        const sandbox = await sandboxZone(services);
        const automations = await services.automations.list();
        const changes = armingMarks(automations, await services.scheduleCoverage.read(), windowStart);
        for (const automation of automations.filter((candidate) => candidate.enabled)) {
            // Per automation: this window is already spent, so one that throws must not cost every later one its moment.
            try {
                // An end date is kept by the tick, not only by a fire, so a webhook or a listener that never comes still
                // ends when it said it would, and says so.
                if (automation.expiresAt !== undefined && automation.expiresAt <= now) {
                    await expireAutomation(services, automation);
                    continue;
                }
                const fired = await fireIfDue(services, automation, windowStart, now, sandbox);
                if (fired !== undefined) {
                    changes[automation.id] = { coveredUntil: fired };
                }
            } catch (error) {
                loggedAs(services, "automation could not be checked for a due run", automation.id)(error);
            }
        }
        await services.scheduleCoverage.mark(changes);
        await releaseCountdownHolds(services, now, due);
        const next = nextDueAfter(automations, now, sandbox);
        if (next !== undefined) {
            due(next);
        }
    };
    const passes = nudgedPass(pass, { backstopMs: intervalMs, failed: loggedAs(services, "automations pass failed") });

    const catchUp = async (): Promise<void> => {
        const horizon = since;
        const sandbox = await sandboxZone(services);
        const automations = await services.automations.list();
        const marks = await services.scheduleCoverage.read();
        const changes = armingMarks(automations, marks, horizon);
        const owed = automations.flatMap((automation) => {
            const missed = automation.enabled ? missedMoment(automation, marks[automation.id], horizon, sandbox) : undefined;
            return missed === undefined ? [] : [{ automation, missed }];
        });
        for (const { automation } of owed) {
            changes[automation.id] = { coveredUntil: horizon };
        }
        // Covered before fired, as a one-time wake retires before it fires: a daemon that dies under the catch-up
        // resumes that fire from the turn journal, and must not owe the same moment again on top of it.
        await services.scheduleCoverage.mark(changes);
        for (const { automation, missed } of owed) {
            void fireAutomation(services, automation, { late: lateWakeNote(missed, Date.now(), sandbox) }).catch(
                loggedAs(services, "missed scheduled run failed", automation.id),
            );
        }
    };

    return {
        tick: passes.run,
        nudge: passes.nudge,
        start: () => {
            // A second start would settle the same catch-up twice.
            if (started) {
                return;
            }
            started = true;
            void catchUp().catch(loggedAs(services, "automations catch-up failed"));
            passes.start();
        },
        stop: () => {
            started = false;
            passes.stop();
        },
    };
};
