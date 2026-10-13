import type { RestartResume } from "../agent/run/turn/restart-resume-policy.js";
import { consumeEntry, type JournalEntry, resumeBars, spendAttempt } from "../agent/run/turn/turn-journal.js";
import { settingsResume } from "../agent/run/turn/turn-resume.js";
import type { Services } from "../composition.js";
import { opt } from "../opt.js";
import { fireOnThread, resumable, type ThreadFireOptions, type ThreadPlace } from "./scheduler.js";

type JournalledFire = Extract<JournalEntry, { kind: "automation" }>;

// What the re-fire is handed of the fire it replaces: the trigger inputs it was snapshotted with, and the lane its
// sender's rule decided, so a stranger put on a narrow persona comes back on that persona rather than the automation's.
// The lane's own approval was answered when the fire first ran, so the re-fire asks for none.
const refireOptions = (entry: JournalledFire): ThreadFireOptions => ({
    // Only the approval gate is skipped, since the wake was already past it when the daemon died; the guard still runs.
    cleared: "approval",
    attempts: entry.attempts + 1,
    ...opt("payload", entry.payload),
    ...opt("origin", entry.origin),
    ...opt("title", entry.title),
    ...opt("lane", entry.lane === undefined ? undefined : { actsAs: entry.lane.actsAs, requireApproval: false }),
});

// The conversation the re-fire continues: the one it was cut on, on the thread and provider session it belonged to, so
// the thread is settled after it like the original would have been and its next message resumes the same session.
const refirePlace = (entry: JournalledFire): ThreadPlace => ({ key: entry.thread, conversationId: entry.conversationId, sessionId: entry.sessionId });

// One interrupted fire: recorded interrupted whatever happens next, since the run's own record is the only place the
// interruption shows, then re-fired or left so.
const resumeFire = async (services: Services, entry: JournalledFire, now: number, policy: RestartResume): Promise<void> => {
    const autoResumeOnRestart = policy.resume;
    await services.automations
        .recordRun(entry.automationId, {
            at: now,
            outcome: "interrupted",
            detail: "the sandbox restarted while this run was in flight",
            conversationId: entry.conversationId,
        })
        .catch((error: unknown) => services.logger.warn({ err: error, automation: entry.automationId }, "interrupted run not recorded"));
    const { spent, stale } = resumeBars(entry, now);
    if (!autoResumeOnRestart || spent || stale) {
        await consumeEntry(services, entry);
        services.logger.info(
            { entry: entry.kind, spent, stale, autoResumeOnRestart },
            "interrupted turn not resumed: the interruption stands on the record",
        );
        return;
    }
    // Re-fires through fireAutomation, the same road an approved wake takes, re-reading the prompt in case it changed.
    const automation = await services.automations.get(entry.automationId);
    if (automation === undefined || !resumable(automation)) {
        // Consumed rather than kept: it can never fire, and keeping it would fabricate a second run next boot.
        await consumeEntry(services, entry);
        services.logger.info({ automation: entry.automationId }, "interrupted fire not resumed, the automation is gone or disabled");
        return;
    }
    await spendAttempt(services, entry);
    // Detached, must not hold up the boot; fireAutomation writes its own fresh entry over the one just spent.
    void fireOnThread(services, automation, refirePlace(entry), refireOptions(entry)).catch((error: unknown) =>
        services.logger.error({ err: error, automation: entry.automationId }, "interrupted fire failed to resume"),
    );
    services.logger.info({ automation: entry.automationId }, "restart auto-refire fired");
};

// Runs once at boot, beside the engine's own pass over the turns it died under (agent/run/turn/turn-resume.ts). Each
// entry is consumed or spent before it fires, so a fire that kills the daemon can't loop the boot. The journal holds a
// fire per conversation, so threads of one automation that were worked on side by side each come back on their own
// conversation, side by side again (scheduler.ts, FireLanes).
// `policy`: whether this boot resumes what the restart cut (agent/run/turn/restart-resume-policy.ts), decided once for
// every pass; absent, it is the settings' autoResumeOnRestart alone.
export const resumeInterruptedFires = async (services: Services, now: number = Date.now(), policy?: RestartResume): Promise<void> => {
    const listed = await services.turnJournal.list().catch((error: unknown): JournalEntry[] => {
        services.logger.warn({ err: error }, "turn journal: unreadable at boot, no interrupted fire is re-fired");
        return [];
    });
    const interrupted = listed.filter((entry): entry is JournalledFire => entry.kind === "automation");
    if (interrupted.length === 0) {
        return;
    }
    const resume = policy ?? (await settingsResume(services));
    for (const entry of interrupted) {
        await resumeFire(services, entry, now, resume);
    }
};
