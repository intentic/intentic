import { consumeEntry, type JournalEntry, resumeBars, spendAttempt } from "../agent/run/turn/turn-journal.js";
import type { Services } from "../composition.js";
import { type FireOptions, fireAutomation, resumable } from "./scheduler.js";

type JournalledFire = Extract<JournalEntry, { kind: "automation" }>;

// What the re-fire is handed of the fire it replaces: its conversation, and the trigger inputs it was snapshotted with.
const refireOptions = (entry: JournalledFire): FireOptions => ({
    // Only the approval gate is skipped, since the wake was already past it when the daemon died; the guard still runs.
    cleared: "approval",
    attempts: entry.attempts + 1,
    conversationId: entry.conversationId,
    ...(entry.payload !== undefined ? { payload: entry.payload } : {}),
    ...(entry.origin !== undefined ? { origin: entry.origin } : {}),
    ...(entry.title !== undefined ? { title: entry.title } : {}),
});

// One interrupted fire: recorded interrupted whatever happens next, since the run's own record is the only place the
// interruption shows, then re-fired or left so.
const resumeFire = async (services: Services, entry: JournalledFire, now: number, autoResumeOnRestart: boolean): Promise<void> => {
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
    void fireAutomation(services, automation, refireOptions(entry)).catch((error: unknown) =>
        services.logger.error({ err: error, automation: entry.automationId }, "interrupted fire failed to resume"),
    );
    services.logger.info({ automation: entry.automationId }, "restart auto-refire fired");
};

// Runs once at boot, beside the engine's own pass over the turns it died under (agent/run/turn/turn-resume.ts). Each
// entry is consumed or spent before it fires, so a fire that kills the daemon can't loop the boot.
export const resumeInterruptedFires = async (services: Services, now: number = Date.now()): Promise<void> => {
    const listed = await services.turnJournal.list().catch((error: unknown): JournalEntry[] => {
        services.logger.warn({ err: error }, "turn journal: unreadable at boot, no interrupted fire is re-fired");
        return [];
    });
    const interrupted = listed.filter((entry): entry is JournalledFire => entry.kind === "automation");
    if (interrupted.length === 0) {
        return;
    }
    const { autoResumeOnRestart } = await services.sandboxSettings.get();
    for (const entry of interrupted) {
        await resumeFire(services, entry, now, autoResumeOnRestart);
    }
};
